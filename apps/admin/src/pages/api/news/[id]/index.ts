import {
  createArticleGet,
  createArticlePut,
} from '../../../../lib/article-endpoints';

export const GET = createArticleGet('news');
export const PUT = createArticlePut('news');
