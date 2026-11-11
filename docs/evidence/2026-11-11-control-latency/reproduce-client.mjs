import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(process.cwd() + '/frontend/package.json')
const esbuild = require('esbuild')
globalThis.crypto ??= webcrypto
globalThis.window = {location: {hostname: 'localhost', search: ''}}
const built = await esbuild.build({entryPoints: ['frontend/src/lib/control-session-client.ts'],bundle:true,format:'esm',platform:'node',write:false})
const {ControlSessionClient} = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'))
const sessionId='e0dfe6c0-63ee-416d-81b1-689bf10c785d'
let now=1000
const originalNow=performance.now.bind(performance)
performance.now=()=>now
function fixture() {
 let instance, published=0
 const session=()=>({session_id:sessionId,vehicle_id:'car-test',protocol_version:2,client_instance_id:instance,sender_identity:'control-'+sessionId,status:'ACTIVE'})
 const c=new ControlSessionClient('car-test','http://localhost','synthetic-test-token',{
  connect:async()=>{},publish:async()=>{published++},disconnect:async()=>{}
 },()=>{},async(url,opts)=>{
  if(url.endsWith('/acquire')){instance=JSON.parse(opts.body).client_instance_id;return Response.json({session:session(),token:'synthetic-test-token',renew_after_ms:10000})}
  if(url.endsWith('/release'))return Response.json({}, {status:202})
  if(url.endsWith('/handover'))return Response.json({vehicle_id:'car-test',session_id:sessionId,state:'CONFIRMED',vehicle_handover_confirmed:true})
  throw Error('Unexpected path')
 })
 const accept=()=>c.acceptFeedback('vehicle-car-test',true,new TextEncoder().encode(JSON.stringify({version:2,type:'control.feedback',vehicle_id:'car-test',session_id:sessionId,receiver_instance_id:'a'.repeat(32),revision:1,accepted_sequence:0,status:'READY',reason:'awaiting_command',last_rejection:'',simulation:true,command:null})))
 return {c,accept,published:()=>published}
}
const sign=crypto.subtle.sign.bind(crypto.subtle)
let first=fixture()
try {
 await first.c.acquire();first.accept()
 crypto.subtle.sign=async(...args)=>{const signature=await sign(...args);now+=300;return signature}
 await first.c.tick()
 assert.equal(first.published(),0)
 assert.equal(first.c.state,'locked')
 assert.match(first.c.error,/stalled/)
 console.log('FIX VERIFIED: a signature finishing after 300 ms is discarded and locks control without waiting for another tick.')
} finally {crypto.subtle.sign=sign;await first.c.release()}
let second=fixture(),value=0
try {
 await second.c.acquire();second.accept()
 crypto.subtle.sign=async(...args)=>{const signature=await sign(...args);value=value?0:1;second.c.setCommand({steering:0,throttle:value,brake:0,direction:1});return signature}
 for(let i=0;i<7;i++)await second.c.tick()
 assert.equal(second.published(),0)
 second.accept()
 assert.equal(second.c.state,'ready')
 assert.equal(second.c.error,'')
 console.log('FIX VERIFIED: seven superseded signatures publish zero packets and do not create acknowledgement debt.')
} finally {crypto.subtle.sign=sign;await second.c.release();performance.now=originalNow}
