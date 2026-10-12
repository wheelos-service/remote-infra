interface CameraTrack {
    kind: string;
    name?: string;
    attach(): HTMLMediaElement;
    detach(): HTMLMediaElement[];
}

interface TrackPublication {
    trackName?: string;
}

export function createVideoGrid(onVideoReceived: () => void) {
    const slots = new Map(
        Array.from(document.querySelectorAll<HTMLElement>('.video-slot'))
            .map(slot => [slot.dataset.camera ?? '', slot]),
    );
    const tracks = new Map<string, CameraTrack>();
    const grid = document.getElementById('video-grid');
    const container = document.getElementById('video-container');
    const focusButton = document.getElementById('camera-focus');
    let centerFocused = false;

    function updateLayout() {
        const visibleCount = [...slots.values()]
            .filter(slot => slot.classList.contains('has-video')).length;
        const centerAvailable = slots.get('center')?.classList.contains('has-video') ?? false;
        if (visibleCount <= 1 || !centerAvailable) centerFocused = false;
        grid?.classList.toggle('single-camera', visibleCount <= 1);
        grid?.classList.toggle('multi-camera', visibleCount > 1);
        grid?.classList.toggle('center-focused', centerFocused && centerAvailable);
        container?.classList.toggle('single-camera', visibleCount <= 1);
        container?.classList.toggle('center-focused', centerFocused && centerAvailable);
        if (focusButton) {
            focusButton.innerText = centerFocused ? '恢复三路布局' : '放大中间';
        }
    }

    function toggleCenterFocus() {
        centerFocused = !centerFocused;
        updateLayout();
    }

    function cameraName(track: CameraTrack, publication?: TrackPublication): string {
        const name = publication?.trackName || track.name || '';
        if (name === 'camera') return 'front';
        return name.startsWith('camera-') ? name.slice('camera-'.length) : '';
    }

    function subscribe(track: CameraTrack, publication?: TrackPublication) {
        if (track.kind !== 'video') return;
        const name = cameraName(track, publication);
        const slot = slots.get(name);
        if (!slot) {
            console.warn('Ignoring video track with unknown camera name:', name);
            track.detach();
            return;
        }

        tracks.get(name)?.detach();
        const feed = slot.querySelector('.camera-feed');
        feed?.replaceChildren(track.attach());
        slot.classList.add('has-video');
        tracks.set(name, track);
        updateLayout();
        onVideoReceived();
    }

    function unsubscribe(track: CameraTrack) {
        for (const [name, subscribedTrack] of tracks) {
            if (subscribedTrack !== track) continue;
            track.detach();
            const slot = slots.get(name);
            slot?.querySelector('.camera-feed')?.replaceChildren();
            slot?.classList.remove('has-video');
            tracks.delete(name);
            updateLayout();
            return;
        }
    }

    function clear() {
        for (const [name, track] of tracks) {
            track.detach();
            const slot = slots.get(name);
            slot?.querySelector('.camera-feed')?.replaceChildren();
            slot?.classList.remove('has-video');
        }
        tracks.clear();
        centerFocused = false;
        updateLayout();
    }

    focusButton?.addEventListener('click', toggleCenterFocus);
    updateLayout();

    return {subscribe, unsubscribe, clear};
}
