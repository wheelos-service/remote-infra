import test from 'node:test';
import assert from 'node:assert/strict';
import {createVideoGrid} from '../dist/lib/video-grid.js';
class Element {
    dataset = {}; classes = new Set(); children = []; handlers = new Map(); value = 'auto';
    classList = {contains: n => this.classes.has(n), add: n => this.classes.add(n),
        remove: n => this.classes.delete(n), toggle: (n, on) => on ? this.classes.add(n) : this.classes.delete(n)};
    replaceChildren(...children) { this.children = children; }
    addEventListener(n, cb) { if (!this.handlers.has(n)) this.handlers.set(n, new Set()); this.handlers.get(n).add(cb); }
    removeEventListener(n, cb) { this.handlers.get(n)?.delete(cb); }
    emit(n) { for (const cb of this.handlers.get(n) ?? []) cb(); }
    blur() {}
}
class Video extends Element {
    readyState = 2; callbacks = new Map(); sequence = 0;
    requestVideoFrameCallback(cb) { this.callbacks.set(++this.sequence, cb); return this.sequence; }
    cancelVideoFrameCallback(id) { this.callbacks.delete(id); }
    frame() { const callbacks = [...this.callbacks.values()]; this.callbacks.clear(); for (const cb of callbacks) cb(); }
}
function setup(t) {
    const slots = new Map(['left','center','right','rear-left','rear-center','rear-right','front'].map(name => {
        const e = new Element(), feed = new Element(); e.dataset.camera = name; e.querySelector = () => feed; return [name, e];
    }));
    const controls = new Map(['video-grid','video-container','camera-focus','camera-view','camera-view-status'].map(n => [n, new Element()]));
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {configurable:true, value: {
        querySelectorAll: () => [...slots.values()], getElementById: n => controls.get(n)}});
    t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
    let now = 100, timer;
    t.mock.method(performance, 'now', () => now);
    t.mock.method(globalThis, 'setInterval', cb => { timer = cb; return 1; });
    const cleared = []; t.mock.method(globalThis, 'clearInterval', id => cleared.push(id));
    const grid = createVideoGrid(() => {}), tracks = [];
    const track = name => {
        const v = new Video(), x = {kind:'video', name:`camera-${name}`, video:v, attached:0, detached:0,
            attach() { this.attached++; return v; }, detach() { this.detached++; return [v]; }};
        tracks.push(x); return x;
    };
    return {grid, track, tracks, slots, controls, cleared,
        visible: () => [...slots].filter(([,e]) => e.classList.contains('is-visible')).map(([n]) => n),
        tick: ms => { now += ms; timer(); }};
}
test('all six feeds stay attached across group switches; missing rear view never shows front video', t => {
    const h = setup(t);
    for (const n of ['rear-right','center','right','rear-left','left','rear-center']) {
        const x = h.track(n); h.grid.subscribe(x); x.video.frame();
    }
    assert.deepEqual(h.visible(), ['left','center','right']);
    h.grid.noteCommand({mode:'high_level',action:'reverse'});
    assert.deepEqual(h.visible(), ['rear-left','rear-center','rear-right']);
    for (const x of h.tracks) { assert.equal(x.attached,1); assert.equal(x.detached,0); }
    assert.equal(h.slots.get('rear-center').querySelector().children[0], h.tracks[5].video);
    h.grid.unsubscribe(h.tracks[3]);
    assert.deepEqual(h.visible(), ['rear-left','rear-center','rear-right']);
    assert.equal(h.slots.get('rear-left').classList.contains('has-video'), false);
    h.grid.setViewMode('front'); h.grid.noteCommand({mode:'high_level',action:'reverse'});
    assert.deepEqual(h.visible(), ['left','center','right']);
    h.grid.setViewMode('auto'); assert.deepEqual(h.visible(), ['rear-left','rear-center','rear-right']);
    h.grid.clear(); for (const x of h.tracks) assert.equal(x.detached,1);
    assert.equal(h.cleared.length,1); assert.equal(h.controls.get('camera-view').value,'auto');
});
test('frame staleness, recovery and track replacement clean up correctly', t => {
    const h = setup(t), x = h.track('rear-center'); h.grid.subscribe(x); x.video.frame();
    assert.equal(h.slots.get('rear-center').classList.contains('has-video'),true);
    h.tick(2100); assert.equal(h.slots.get('rear-center').classList.contains('has-video'),false);
    x.video.frame(); assert.equal(h.slots.get('rear-center').classList.contains('has-video'),true);
    x.video.emit('waiting'); assert.equal(h.slots.get('rear-center').classList.contains('has-video'),false);
    const next = h.track('rear-center'); h.grid.subscribe(next); h.grid.unsubscribe(x);
    assert.equal(x.detached,1); assert.equal(x.video.callbacks.size,0); assert.equal(next.detached,0);
    assert.equal(h.slots.get('rear-center').querySelector().children[0],next.video); h.grid.clear();
});
test('single-camera compatibility and center focus for rear group', t => {
    const h = setup(t); h.grid.subscribe(h.track('front')); assert.deepEqual(h.visible(),['front']);
    const x = h.track('rear-center'); h.grid.subscribe(x); x.video.frame(); h.grid.setViewMode('rear');
    h.controls.get('camera-focus').emit('click'); assert.equal(h.controls.get('video-grid').classList.contains('center-focused'),true);
    h.grid.setViewMode('front'); assert.equal(h.controls.get('video-grid').classList.contains('center-focused'),false); h.grid.clear();
});
