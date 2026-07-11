import {
  createArticleGet,
  createArticlePut,
} from '../../../../lib/article-endpoints';

export const GET = createArticleGet('playguide');
export const PUT = createArticlePut('playguide');
