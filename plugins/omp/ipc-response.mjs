// Bun can fold an ordinary short stream into Content-Length. Flush each write
// through its direct stream so the private F# peer receives chunked framing.
export function ipcResponse(response, allowedHeaders) {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (name === "content-length" || name === "transfer-encoding") continue;
    if (!allowedHeaders || allowedHeaders.includes(name)) headers.set(name, value);
  }
  const reader = response.body?.getReader();
  let closed = false;
  const cancel = async reason => {
    if (closed) return;
    closed = true;
    try { await reader?.cancel(reason); } finally { reader?.releaseLock(); }
  };
  const body = new ReadableStream({
    type: "direct",
    async pull(output) {
      try {
        while (!closed) {
          const item = reader ? await reader.read() : { done: true };
          if (closed) return;
          if (item.done) {
            closed = true;
            reader?.releaseLock();
            output.end();
            return;
          }
          output.write(item.value);
          await output.flush();
        }
      } catch (error) { await cancel(error); throw error; }
    },
    cancel,
  });
  return new Response(body, { status: response.status, headers });
}
