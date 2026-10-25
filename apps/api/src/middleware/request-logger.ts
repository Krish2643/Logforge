import { pinoHttp } from "pino-http";
import type { Logger } from "pino";

export function createRequestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId(_request, response) {
      return String(response.getHeader("X-Request-ID"));
    },
    serializers: {
      req(request) {
        return {
          method: request.method,
          path: request.url?.split("?")[0]
        };
      },
      res(response) {
        return { statusCode: response.statusCode };
      }
    },
    customLogLevel(_request, response, error) {
      if (error || response.statusCode >= 500) return "error";
      if (response.statusCode >= 400) return "warn";
      return "info";
    },
    customErrorObject(_request, _response, error) {
      return { errorName: error.name };
    }
  });
}
