import { defineMiddleware } from 'astro:middleware';

import { createDb, FALLBACK_LANGUAGE, getEnabledLanguages } from '@hiroba/db';

import { CACHE_LIST } from './lib/cache';

/** Language-neutral route prefixes (never language-prefixed). */
const isNeutralPath = (pathname: string): boolean =>
  pathname.startsWith('/api/') || pathname.startsWith('/img/');

/** Pre-language content paths, redirected into the default language tree. */
const isLegacyContentPath = (pathname: string): boolean =>
  /^\/(news|topics|playguide|category|calendar)(\/|$)/.test(pathname);

/** Shaped like a language code — a stale prefix worth rescuing via redirect. */
const looksLikeLanguage = (segment: string): boolean =>
  /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/i.test(segment);

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, request, locals, redirect } = context;
  const pathname = url.pathname;

  // API + image routes are language-neutral; APIs get CORS, nothing else.
  if (isNeutralPath(pathname)) {
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
    if (pathname.startsWith('/api/')) {
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    return response;
  }

  // Everything else is a page under /<lang>/…. Resolve the whitelist; if the
  // languages table is unreachable the site stays up in English rather than
  // 500ing every page.
  let languages: App.SiteLanguage[];
  try {
    languages = await getEnabledLanguages(createDb(locals.runtime.env.DB));
  } catch {
    languages = [{ ...FALLBACK_LANGUAGE }];
  }
  locals.languages = languages;
  const defaultLang = (languages.find((l) => l.code === 'en') ?? languages[0])
    .code;

  const [, first = '', ...restSegments] = pathname.split('/');
  const active = languages.find((l) => l.code === first);

  if (!active) {
    // The bare root and pre-language content URLs land on the default tree.
    if (pathname === '/') {
      return redirect(`/${defaultLang}`, 302);
    }
    if (isLegacyContentPath(pathname)) {
      return redirect(`/${defaultLang}${pathname}${url.search}`, 301);
    }
    // A no-longer-whitelisted language prefix on a content path: same page,
    // default language. (302 — the prefix may be re-enabled.)
    const rest = `/${restSegments.join('/')}`;
    if (
      looksLikeLanguage(first) &&
      (rest === '/' || isLegacyContentPath(rest))
    ) {
      return redirect(
        `/${defaultLang}${rest === '/' ? '' : rest}${url.search}`,
        302,
      );
    }
    return new Response('Not found', { status: 404 });
  }

  locals.lang = active.code;

  const response = await next();

  // Pages that need a specific policy (articles by readiness, the calendar's
  // top-of-hour rollover) set their own Cache-Control via Astro.response; only
  // fill the default when they didn't. The default suits the list/index pages.
  if (!response.headers.has('Cache-Control')) {
    response.headers.set('Cache-Control', CACHE_LIST);
  }
  return response;
});
