export async function createFrameMetadataWorker(): Promise<Worker | undefined> {
  let worker: Worker
  try {
    worker = new Worker(new URL('frame-metadata-worker.js', document.baseURI))
  } catch {
    return
  }
  const ready = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => finish(false), 1000)
    const finish = (success: boolean) => {
      clearTimeout(timer)
      worker.onmessage = null
      worker.onerror = null
      resolve(success)
    }
    worker.onmessage = event => { if (event.data?.kind === 'initAck') finish(true) }
    worker.onerror = () => finish(false)
    try { worker.postMessage({ kind: 'init' }) } catch { finish(false) }
  })
  if (ready) return worker
  worker.terminate()
}

export function watchFrameMetadataWorker(
  worker: Worker, lifecycle: { readonly active: boolean; fail(error: Error): void }, isDisposed: () => boolean,
): () => void {
  let watching = true
  const failed = () => {
    if (watching && !isDisposed() && lifecycle.active) {
      lifecycle.fail(new Error('视频元数据处理失败；监看已停止，请重新连接'))
    }
  }
  worker.addEventListener('error', failed)
  return () => {
    watching = false
    worker.removeEventListener('error', failed)
  }
}
