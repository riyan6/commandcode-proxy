// 流读取工具：带空闲超时地读取一个 ReadableStream reader。
// 关键点是 read() 先完成时也要清理定时器，
// 否则每个 chunk 都会遗留一个待触发的超时定时器，长流下大量积压。

export const STREAM_IDLE_TIMEOUT_ERROR = 'STREAM_IDLE_TIMEOUT';

export async function readWithTimeout(reader, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(STREAM_IDLE_TIMEOUT_ERROR)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
