// The generated 640x480 bench frame carries 12 bytes across its top row.
// Verify source identity, process epoch and CRC before reading the clock.
export interface BenchClock { epoch: number; elapsed_ms: number; started: number; received: number }

export function generatedFrameStamp(pixels: Uint8ClampedArray, camera: number, epoch: number): number | undefined {
  if (pixels.length !== 96 * 4 || camera < 0 || camera > 2) return
  const bytes = new Uint8Array(12)
  for (let bit = 0; bit < 96; bit++) {
    const level = pixels[4 * bit]
    if (level > 84 && level < 172) return
    bytes[bit >> 3] |= Number(level >= 172) << (7 - bit % 8)
  }
  if (bytes[0] !== 0xb0 + camera || new DataView(bytes.buffer).getUint32(1) !== epoch) return
  let crc = 0xffff
  for (const byte of bytes.subarray(0, 10)) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff
  }
  if (crc !== (bytes[10] << 8 | bytes[11])) return
  return bytes.subarray(5, 10).reduce((value, byte) => value * 256 + byte, 0)
}

export function captureDeadline(clock: BenchClock, stamp: number, now: number): number {
  if (now < clock.received || clock.received < clock.started || now - clock.started > 15000) return 0
  const elapsed = now - clock.started
  // The Gateway sampled after request start. Include RTT, timer resolution and 1000 ppm drift.
  const age = clock.elapsed_ms + elapsed * 1.001 + 2 - stamp
  if (!Number.isFinite(age) || age < 0 || age >= 1000) return 0
  return Math.min(clock.started + 15000, now + (1000 - age) / 1.001)
}

export function readGeneratedFrame(video: HTMLVideoElement, context: CanvasRenderingContext2D,
  camera: number, epoch: number): number | undefined {
  if (!video.videoWidth || !video.videoHeight) return
  // Scale crop coordinates if the encoder adapted resolution.
  context.drawImage(video, 0, video.videoHeight * 6 / 480, video.videoWidth * 576 / 640,
    video.videoHeight * 4 / 480, 0, 0, 96, 1)
  return generatedFrameStamp(context.getImageData(0, 0, 96, 1).data, camera, epoch)
}
