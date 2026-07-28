import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteMatch {
  params: Record<string, string>;
  query: URLSearchParams;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RouteMatch,
) => void | Promise<void>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/**
 * A ~60-line router instead of a framework dependency. The API surface is a
 * handful of read-only routes; a framework would be more code to audit than this.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pattern),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  /** Returns the handler plus extracted params, or the reason nothing matched. */
  resolve(
    method: string,
    pathname: string,
    query: URLSearchParams,
  ): { handler: RouteHandler; match: RouteMatch } | { error: 'not_found' | 'method_not_allowed' } {
    const segments = splitPath(pathname);
    let pathMatched = false;

    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (params === undefined) continue;
      pathMatched = true;
      // HEAD is served by the GET handler; Node drops the body for us.
      const effective = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
      if (route.method !== effective) continue;
      return { handler: route.handler, match: { params, query } };
    }

    return { error: pathMatched ? 'method_not_allowed' : 'not_found' };
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i] as string;
    const a = actual[i] as string;
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return undefined;
    }
  }
  return params;
}
