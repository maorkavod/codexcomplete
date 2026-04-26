import * as https from "https";

export interface JsonRequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  includeRawResponseText?: boolean;
}

export interface JsonResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  rawText?: string;
}

export async function requestJson<T>(
  url: string,
  options: JsonRequestOptions
): Promise<JsonResponse<T>> {
  return new Promise<JsonResponse<T>>((resolve, reject) => {
    let settled = false;
    const parsedUrl = new URL(url);
    const bodyText =
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);

    const req = https.request(
      parsedUrl,
      {
        method: options.method,
        headers: {
          ...(options.headers ?? {}),
          ...(bodyText !== undefined ? { "Content-Length": Buffer.byteLength(bodyText).toString() } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let data: T | null = null;

          if (rawBody.trim().length > 0) {
            try {
              data = JSON.parse(rawBody) as T;
            } catch {
              data = null;
            }
          }

          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            data,
            ...(options.includeRawResponseText ? { rawText: rawBody } : {})
          });
        });
      }
    );

    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      req.destroy(new Error("Request aborted"));
      reject(new Error("Request aborted"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => options.signal?.removeEventListener("abort", onAbort));
    }

    if (bodyText !== undefined) {
      req.write(bodyText);
    }
    req.end();
  });
}
