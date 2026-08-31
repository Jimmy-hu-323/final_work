function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "");
}

export function isTransientAlbumAnalysisError(error: unknown): boolean {
  const message = errorMessage(error);
  if (
    /API Key|未配置|配置.*模型|invalid.*model|unsupported|\b(?:400|401|403)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  return /error sending request|network|connection|timeout|timed out|temporar|reset|refused|\b(?:408|425|429|500|502|503|504)\b|网络|连接|超时|稍后重试/i.test(
    message,
  );
}

export async function retryAlbumAnalysis<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts || 3);
  const delayMs = Math.max(0, options.delayMs ?? 650);
  const sleep =
    options.sleep ||
    ((milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientAlbumAnalysisError(error)) {
        throw error;
      }
      await sleep(delayMs * attempt);
    }
  }
}
