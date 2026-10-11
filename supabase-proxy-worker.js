/**
 * Cloudflare Worker - Supabase 反向代理
 * 部署后将应用中的 Supabase URL 替换为 Worker 的 URL
 * 免费额度：每天 100,000 次请求
 */

// 你的 Supabase 项目 URL
const SUPABASE_URL = 'https://fdoxhnfhtdzhefmhlcas.supabase.co';

export default {
  async fetch(request, env, ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    try {
      // 构建目标 URL：保留路径和查询参数
      const url = new URL(request.url);
      const targetUrl = SUPABASE_URL + url.pathname + url.search;

      // 复制请求头，删除会冲突的头
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('cf-connecting-ip');
      headers.delete('cf-ipcountry');
      headers.delete('cf-ray');
      headers.delete('cf-visitor');
      headers.delete('x-forwarded-for');
      headers.delete('x-forwarded-proto');

      // 构建转发请求
      const proxyRequest = new Request(targetUrl, {
        method: request.method,
        headers: headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow'
      });

      // 发起请求到 Supabase
      const response = await fetch(proxyRequest);

      // 构建响应头，添加 CORS
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
      responseHeaders.set('Access-Control-Allow-Headers', 'apikey, authorization, content-type, x-client-info, prefer, x-upsert');
      responseHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length');

      // 删除可能导致问题的安全头（Worker 域和 Supabase 域不同）
      responseHeaders.delete('content-security-policy');
      responseHeaders.delete('strict-transport-security');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: 'Proxy error',
        message: error.message
      }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};

// CORS 预检响应
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, prefer, x-upsert',
      'Access-Control-Max-Age': '86400'
    }
  });
}
