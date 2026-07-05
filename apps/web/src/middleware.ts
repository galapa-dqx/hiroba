import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, request } = context;
  const pathname = url.pathname;

  // Handle CORS preflight requests for API routes
  if (pathname.startsWith('/api/') && request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const response = await next();

  // Add CORS headers to API responses
  if (pathname.startsWith('/api/')) {
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }

  // Cache SSR pages for 5 minutes, stale-while-revalidate for 1 hour
  if (
    pathname.startsWith('/news/') ||
    pathname.startsWith('/topics') ||
    pathname.startsWith('/category/') ||
    pathname === '/'
  ) {
    response.headers.set(
      'Cache-Control',
      'public, max-age=300, stale-while-revalidate=3600',
    );
  }

  return response;
});
