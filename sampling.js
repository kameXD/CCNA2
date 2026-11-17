// Direct access to captured frames is independent of the preview compositor.
// A heartbeat also samples static streams that stop emitting identical frames.
export function startSampling(track, interval, sample) {
  let worker, timer, reader, clone, latest;
  let stopped = false;
  let lastSample = -Infinity;

  function run() {
    if (stopped || performance.now() - lastSample < interval - 10) return;
    lastSample = performance.now();
    sample(latest);
  }

  function fallback() {
    worker?.terminate();
    worker = undefined;
    if (!stopped) timer = setInterval(run, interval);
  }

  try {
    worker = new Worker(new URL('./sample-clock.js', import.meta.url));
    worker.onmessage = () => {
      worker?.postMessage(interval);
      run();
    };
    worker.onerror = fallback;
    worker.postMessage(interval);
  } catch {
    fallback();
  }

  async function consume() {
    try {
      if (typeof MediaStreamTrackProcessor !== 'function') return;
      clone = track.clone();
      reader = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 }).readable.getReader();
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        latest?.close();
        if (stopped) value.close();
        else {
          latest = value;
          run();
        }
      }
    } catch {
      // The preview and heartbeat remain available if direct track access fails.
    } finally {
      latest?.close();
      latest = undefined;
      reader?.releaseLock();
      clone?.stop();
    }
  }

  queueMicrotask(run);
  consume();
  return () => {
    stopped = true;
    clearInterval(timer);
    worker?.terminate();
    reader?.cancel().catch(() => {});
    latest?.close();
    latest = undefined;
    clone?.stop();
  };
}
