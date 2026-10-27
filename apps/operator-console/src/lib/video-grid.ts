import type {ControlCommand} from './secure-control-sender.js';
import {CameraView, type ViewMode} from './camera-view.js';

interface CameraTrack {
    kind: string;
    name?: string;
    attach(): HTMLMediaElement;
    detach(): HTMLMediaElement[];
}
interface TrackPublication { trackName?: string; }
type Feed = {
    track: CameraTrack; video: HTMLVideoElement; lastFrameAt: number;
    frameId?: number; cleanup: () => void;
};

export function createVideoGrid(onVideoReceived: () => void) {
    const slots = new Map(Array.from(document.querySelectorAll<HTMLElement>('.video-slot'))
        .map(slot => [slot.dataset.camera ?? '', slot]));
    const tracks = new Map<string, Feed>();
    const grid = document.getElementById('video-grid');
    const container = document.getElementById('video-container');
    const focusButton = document.getElementById('camera-focus') as HTMLButtonElement | null;
    const selector = document.getElementById('camera-view') as HTMLSelectElement | null;
    const status = document.getElementById('camera-view-status');
    const view = new CameraView();
    let centerFocused = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastGroup = view.group;

    function updateLayout() {
        if (lastGroup !== view.group) centerFocused = false;
        lastGroup = view.group;
        const frontSingle = view.group === 'front' && tracks.has('front') &&
            !['left', 'center', 'right'].some(name => tracks.has(name));
        const names = frontSingle ? ['front'] : view.group === 'rear'
            ? ['rear-left', 'rear-center', 'rear-right'] : ['left', 'center', 'right'];
        for (const [name, slot] of slots) slot.classList.toggle('is-visible', names.includes(name));
        const center = slots.get(view.group === 'rear' ? 'rear-center' : 'center');
        const centerAvailable = !frontSingle && Boolean(center?.classList.contains('has-video'));
        if (!centerAvailable) centerFocused = false;
        grid?.classList.toggle('single-camera', frontSingle);
        grid?.classList.toggle('multi-camera', !frontSingle);
        grid?.classList.toggle('center-focused', centerFocused);
        container?.classList.toggle('single-camera', frontSingle);
        container?.classList.toggle('center-focused', centerFocused);
        if (focusButton) {
            focusButton.disabled = !centerAvailable;
            focusButton.innerText = centerFocused ? '恢复三路布局' : '放大中间';
        }
        if (status) status.textContent = view.status;
    }

    function setLive(name: string, live: boolean) {
        slots.get(name)?.classList.toggle('has-video', live);
        updateLayout();
    }
    function remove(name: string) {
        const feed = tracks.get(name);
        if (!feed) return;
        feed.cleanup();
        feed.track.detach();
        tracks.delete(name);
        slots.get(name)?.querySelector('.camera-feed')?.replaceChildren();
        slots.get(name)?.classList.remove('has-video');
        if (!tracks.size && timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    }
    function subscribe(track: CameraTrack, publication?: TrackPublication) {
        if (track.kind !== 'video') return;
        const trackName = publication?.trackName || track.name || '';
        const name = trackName === 'camera' ? 'front'
            : trackName.startsWith('camera-') ? trackName.slice(7) : '';
        const slot = slots.get(name);
        if (!slot) { track.detach(); return; }
        remove(name);
        const video = track.attach() as HTMLVideoElement;
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        const feed: Feed = {track, video, lastFrameAt: -Infinity, cleanup: () => {}};
        tracks.set(name, feed);
        slot.querySelector('.camera-feed')?.replaceChildren(video);
        const fresh = () => {
            if (tracks.get(name) !== feed) return;
            feed.lastFrameAt = performance.now();
            setLive(name, true);
        };
        const stalled = () => setLive(name, false);
        const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
        const frame = () => {
            fresh();
            if (tracks.get(name) === feed) feed.frameId = video.requestVideoFrameCallback(frame);
        };
        const progress = () => { if (!hasFrameCallback && video.readyState >= 2) fresh(); };
        video.addEventListener('timeupdate', progress);
        video.addEventListener('loadeddata', progress);
        for (const event of ['waiting', 'stalled', 'ended', 'error', 'emptied']) video.addEventListener(event, stalled);
        if (hasFrameCallback) feed.frameId = video.requestVideoFrameCallback(frame);
        feed.cleanup = () => {
            if (feed.frameId !== undefined) video.cancelVideoFrameCallback(feed.frameId);
            video.removeEventListener('timeupdate', progress);
            video.removeEventListener('loadeddata', progress);
            for (const event of ['waiting', 'stalled', 'ended', 'error', 'emptied']) video.removeEventListener(event, stalled);
        };
        if (timer === undefined) timer = setInterval(() => {
            for (const [camera, active] of tracks) {
                if (performance.now() - active.lastFrameAt > 2000) setLive(camera, false);
            }
        }, 500);
        updateLayout();
        onVideoReceived();
    }
    function unsubscribe(track: CameraTrack) {
        for (const [name, feed] of tracks) {
            if (feed.track === track) { remove(name); updateLayout(); return; }
        }
    }
    function clear() {
        for (const name of [...tracks.keys()]) remove(name);
        view.reset();
        if (selector) selector.value = 'auto';
        centerFocused = false;
        updateLayout();
    }
    focusButton?.addEventListener('click', () => { centerFocused = !centerFocused; updateLayout(); });
    selector?.addEventListener('change', () => {
        const mode = selector.value;
        if (mode === 'auto' || mode === 'front' || mode === 'rear') setViewMode(mode);
        selector.blur();
    });
    function setViewMode(mode: ViewMode) {
        view.setMode(mode);
        if (selector) selector.value = mode;
        updateLayout();
    }
    function noteCommand(command: ControlCommand) { view.command(command); updateLayout(); }
    function noteGear(gear?: string) { view.gear(gear); updateLayout(); }
    updateLayout();
    return {subscribe, unsubscribe, clear, noteCommand, noteGear, setViewMode};
}
