import {
  createArticleGet,
  createArticlePut,
} from '../../../../lib/article-endpoints';

export const GET = createArticleGet('topic');
export const PUT = createArticlePut('topic');
