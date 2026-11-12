import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'

const bundle = await esbuild.build({
  stdin: {
    contents: `
      import React from 'react';
      export {AuthProvider} from './src/app/AuthProvider';
      export {requestOrganization} from './src/lib/organization-context';
      export const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
})
const previousWindow = globalThis.window
globalThis.window = { location: { hostname: 'localhost', search: '' } }
const module = { exports: {} }
try {
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
    createRequire(import.meta.url), module, module.exports,
  )
} finally { globalThis.window = previousWindow }
const { AuthProvider, requestOrganization, internals } = module.exports

function providerHarness() {
  const states = []
  const effects = []
  let index = 0
  const render = () => {
    const previous = internals.ReactCurrentDispatcher.current
    index = 0
    internals.ReactCurrentDispatcher.current = {
      useState(initial) {
        const current = index++
        if (!(current in states)) states[current] = initial
        return [states[current], next => {
          states[current] = typeof next === 'function' ? next(states[current]) : next
        }]
      },
      useEffect(effect, deps) {
        const current = index++
        const previous = effects[current]
        if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
          previous?.cleanup?.()
          effects[current] = { deps, effect, pending: true }
        }
      },
      useCallback: callback => callback,
      useMemo: factory => factory(),
    }
    try { return AuthProvider({ children: null }).props.value }
    finally { internals.ReactCurrentDispatcher.current = previous }
  }
  return {
    render,
    async settle() {
      render()
      effects.forEach(effect => {
        if (effect.pending) { effect.pending = false; effect.cleanup = effect.effect() }
      })
      await new Promise(resolve => setImmediate(resolve))
      return render()
    },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
  }
}

test('AuthProvider accepts only explicit server contexts, clears static organization headers and preserves managed selection', async () => {
  const previous = { fetch: globalThis.fetch, window: globalThis.window, sessionStorage: globalThis.sessionStorage }
  const orgA = '11111111-1111-4111-8111-111111111111'
  const orgB = '22222222-2222-4222-8222-222222222222'
  const organization = id => ({ org_id: id, name: id, role: 'viewer', can_manage: false, scope: 'none', vehicle_ids: [] })
  try {
    for (const context of [
      { mode: 'static', organizations: [], control_vehicle_ids: ['car-one'] },
      { mode: 'managed', organizations: [organization(orgA), organization(orgB)] },
      { mode: 'managed', organizations: [] },
      { mode: 'unknown', organizations: [] },
      null,
    ]) {
      const storage = new Map([['teleop.organization', orgB]])
      const requests = []
      globalThis.sessionStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key),
      }
      globalThis.window = { location: { hostname: 'localhost', search: '?dev=1' }, prompt: () => 'test-only' }
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), init })
        if (String(url).endsWith('/api/auth/me')) return Response.json({ Name: 'verified-operator', Roles: ['admin'], Organization: 'legacy-tenant' })
        return context ? Response.json(context) : new Response('{}', { status: 404 })
      }
      const provider = providerHarness()
      try {
        let auth = await provider.settle()
        await auth.signInWithDevToken()
        auth = await provider.settle()
        assert.equal(requests.length, 2)
        assert.equal(requests[1].init.headers['X-Organization-ID'], undefined)
        assert.equal(auth.operator.Name, 'verified-operator')
        if (context?.mode === 'static') {
          assert.deepEqual(auth.authorizationContext, context)
          assert.deepEqual(auth.organizations, [])
          assert.equal(auth.organizationId, '')
          assert.equal(requestOrganization(), '')
          assert.equal(storage.has('teleop.organization'), false)
        } else if (context?.mode === 'managed') {
          const expected = context.organizations.length ? orgB : ''
          assert.deepEqual(auth.authorizationContext, context)
          assert.equal(auth.organizationId, expected)
          assert.equal(requestOrganization(), expected)
          if (expected) {
            auth.selectOrganization(orgA)
            auth = provider.render()
            assert.equal(auth.organizationId, orgA)
            assert.equal(requestOrganization(), orgA)
          }
        } else {
          assert.equal(auth.authorizationContext, undefined)
          assert.equal(auth.organizationId, '')
          assert.equal(requestOrganization(), '')
          assert.ok(auth.error)
        }
        auth.signOut()
        auth = provider.render()
        assert.equal(auth.authorizationContext, undefined)
        assert.equal(auth.accessToken, undefined)
        assert.equal(requestOrganization(), '')
      } finally { provider.unmount() }
    }
  } finally { Object.assign(globalThis, previous) }
})

test('unconfigured login stays on this deployment and makes no network or redirect request', async () => {
  const previous = { fetch: globalThis.fetch, window: globalThis.window }
  const provider = providerHarness()
  try {
    globalThis.window = { location: { hostname: 'new-host.example', search: '',
      assign: () => assert.fail('unconfigured login redirected') } }
    globalThis.fetch = () => assert.fail('unconfigured login made a request')
    await provider.render().signIn()
    assert.match(provider.render().error, /尚未配置登录服务/)
  } finally {
    provider.unmount()
    Object.assign(globalThis, previous)
  }
})
