/*
领克每日自动分享脚本
适用：Loon 3.3.9

功能说明：
1. 自动抓取 token / svcsid。
2. 自动抓取 getShareCode 请求模板。
3. 定时从探索页获取文章列表。
4. 自动选择一篇未分享过的文章。
5. 自动请求文章详情，相当于进入文章。
6. 自动上报 ReadCount。
7. 自动上报 ShareCount。
8. 自动调用 getShareCode 获取新的 shareCode。
9. 自动调用 shareReporting，完成 Co 积分分享任务。

Loon 插件配置：

[Script]
http-request ^https:\/\/h5-api\.lynkco\.com\/app\/explore\/home-page\/.* script-path=auto_share.js, requires-body=false, timeout=30, tag=领克抓Token
http-request ^https:\/\/app-services\.lynkco\.com\.cn\/app\/v1\/task\/getShareCode script-path=auto_share.js, requires-body=false, timeout=30, tag=领克抓ShareCode模板
cron "50 11 * * *" script-path=auto_share.js, timeout=60, tag=领克每日自动分享

[MITM]
hostname = h5-api.lynkco.com, h5.lynkco.com, app-services.lynkco.com.cn

首次使用步骤：
1. 打开 Loon，开启代理。
2. 开启 MITM，并安装、信任 Loon 证书。
3. 打开领克 App → 探索 → 随便点进一篇文章。
   这一步用于抓取当前账号的 token / svcsid。
4. 在文章页面点击 分享 → 复制链接。
   这一步用于抓取 getShareCode 请求模板。
5. token / svcsid / getShareCode 模板都抓到后，后续就可以自动执行。

注意：
getShareCode 走 app-services.lynkco.com.cn，和 h5-api 的签名体系不完全一样。
当前脚本会复用抓包得到的 getShareCode 请求头模板，并自动替换文章 ID 相关参数。
如果后续 getShareCode 返回 Invalid Signature，说明 203760416 这套原生签名需要继续补。
*/

const STORE_TOKEN = "lynkco_token";
const STORE_SVCSID = "lynkco_svcsid";
const STORE_USED_IDS = "lynkco_used_article_ids";
const STORE_SHARE_CODE = "lynkco_share_code";
const STORE_SHARE_CODE_HEADERS = "lynkco_share_code_headers";

const APP_CODE = "3fa3314998bd4195a9fe2df3e85e6a12";
const APP_ID = "59701c08ed454a43a9b";
const CA_KEY = "204644386";
const CA_SECRET = "QCl7udM3PB9cOIOwquwPglikFQnzJRsX";

const H5_API_HOST = "https://h5-api.lynkco.com";
const H5_HOST = "https://h5.lynkco.com";
const APP_SERVICE_HOST = "https://app-services.lynkco.com.cn";

function log(msg) {
  console.log(String(msg));
}

function notify(title, sub, msg) {
  log(`[Notify] ${title} | ${sub || ""} | ${msg || ""}`);
  try {
    $notification.post(title, sub || "", msg || "");
  } catch (e) {}
}

function read(key) {
  return $persistentStore.read(key);
}

function write(value, key) {
  return $persistentStore.write(value, key);
}

function mask(str, head, tail) {
  str = String(str || "");
  if (!str) return "empty";
  if (str.length <= head + tail) return str;
  return str.slice(0, head) + "..." + str.slice(-tail);
}

function getHeader(headers, name) {
  if (!headers) return "";
  const keys = Object.keys(headers);
  const found = keys.find(k => k.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : "";
}

function setHeader(headers, name, value) {
  const keys = Object.keys(headers);
  const found = keys.find(k => k.toLowerCase() === name.toLowerCase());
  if (found) {
    headers[found] = value;
  } else {
    headers[name] = value;
  }
}

function delHeader(headers, name) {
  const keys = Object.keys(headers);
  const found = keys.find(k => k.toLowerCase() === name.toLowerCase());
  if (found) delete headers[found];
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function uuidUpper() {
  return uuid().toUpperCase();
}

function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      url: url,
      headers: headers || {}
    };

    if (body !== undefined) {
      opts.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const callback = function (error, response, data) {
      if (error) {
        reject(error);
      } else {
        resolve({
          resp: response,
          data: data
        });
      }
    };

    if (method.toUpperCase() === "GET") {
      $httpClient.get(opts, callback);
    } else {
      $httpClient.post(opts, callback);
    }
  });
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function utf8Bytes(str) {
  const out = [];

  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);

    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6));
      out.push(0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      out.push(0xe0 | (c >> 12));
      out.push(0x80 | ((c >> 6) & 0x3f));
      out.push(0x80 | (c & 0x3f));
    } else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      out.push(0xf0 | (c >> 18));
      out.push(0x80 | ((c >> 12) & 0x3f));
      out.push(0x80 | ((c >> 6) & 0x3f));
      out.push(0x80 | (c & 0x3f));
    }
  }

  return out;
}

function sha256Bytes(inputBytes) {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,
    0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
    0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,
    0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,
    0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,
    0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];

  let H = [
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
  ];

  const bytes = inputBytes.slice();
  const bitLen = bytes.length * 8;

  bytes.push(0x80);

  while ((bytes.length % 64) !== 56) {
    bytes.push(0);
  }

  for (let i = 7; i >= 0; i--) {
    bytes.push((bitLen / Math.pow(256, i)) & 0xff);
  }

  for (let i = 0; i < bytes.length; i += 64) {
    const w = new Array(64);

    for (let j = 0; j < 16; j++) {
      w[j] =
        (bytes[i + j * 4] << 24) |
        (bytes[i + j * 4 + 1] << 16) |
        (bytes[i + j * 4 + 2] << 8) |
        (bytes[i + j * 4 + 3]);
    }

    for (let j = 16; j < 64; j++) {
      const s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }

    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];

    for (let j = 0; j < 64; j++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + S1 + ch + K[j] + w[j]) | 0;

      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }

  const out = [];

  for (const h of H) {
    out.push((h >>> 24) & 0xff);
    out.push((h >>> 16) & 0xff);
    out.push((h >>> 8) & 0xff);
    out.push(h & 0xff);
  }

  return out;
}

function base64(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;

    const n = (a << 16) | (b << 8) | c;

    out += chars[(n >>> 18) & 63];
    out += chars[(n >>> 12) & 63];
    out += i + 1 < bytes.length ? chars[(n >>> 6) & 63] : "=";
    out += i + 2 < bytes.length ? chars[n & 63] : "=";
  }

  return out;
}

function hmacSha256Base64(message, key) {
  let keyBytes = utf8Bytes(key);

  if (keyBytes.length > 64) {
    keyBytes = sha256Bytes(keyBytes);
  }

  while (keyBytes.length < 64) {
    keyBytes.push(0);
  }

  const oKey = [];
  const iKey = [];

  for (let i = 0; i < 64; i++) {
    oKey[i] = keyBytes[i] ^ 0x5c;
    iKey[i] = keyBytes[i] ^ 0x36;
  }

  const inner = sha256Bytes(iKey.concat(utf8Bytes(message)));
  const mac = sha256Bytes(oKey.concat(inner));
  return base64(mac);
}

function canonicalizePathForSign(pathWithQuery) {
  if (!pathWithQuery.includes("?")) {
    return pathWithQuery;
  }

  const parts = pathWithQuery.split("?");
  const path = parts[0];
  const query = parts.slice(1).join("?");

  if (!query) {
    return path;
  }

  const params = query
    .split("&")
    .filter(x => x !== "")
    .map(item => {
      const idx = item.indexOf("=");

      if (idx < 0) {
        return {
          key: decodeURIComponent(item),
          value: null
        };
      }

      const key = decodeURIComponent(item.slice(0, idx));
      const value = decodeURIComponent(item.slice(idx + 1));

      return {
        key: key,
        value: value
      };
    });

  params.sort((a, b) => {
    if (a.key === b.key) return 0;
    return a.key < b.key ? -1 : 1;
  });

  const canonicalQuery = params.map(p => {
    if (p.value === null || p.value === "") {
      return encodeURIComponent(p.key);
    }

    return encodeURIComponent(p.key) + "=" + encodeURIComponent(p.value);
  }).join("&");

  return path + "?" + canonicalQuery;
}

function buildH5SignedHeaders(method, pathWithQuery) {
  const token = read(STORE_TOKEN);
  const svcsid = read(STORE_SVCSID);

  const timestamp = String(Date.now());
  const nonce = uuid();

  const accept = "*/*";
  const contentType = "application/json";
  const signPath = canonicalizePathForSign(pathWithQuery);

  const stringToSign = [
    method.toUpperCase(),
    accept,
    "",
    contentType,
    "",
    `X-Ca-Key:${CA_KEY}`,
    `X-Ca-Nonce:${nonce}`,
    "X-Ca-Signature-Method:HmacSHA256",
    `X-Ca-Timestamp:${timestamp}`,
    signPath
  ].join("\n");

  const signature = hmacSha256Base64(stringToSign, CA_SECRET);

  log(`Sign ${method.toUpperCase()} requestPath = ${pathWithQuery}`);
  log(`Sign ${method.toUpperCase()} signPath = ${signPath}`);

  return {
    "svcsid": svcsid || token || "",
    "origin": H5_HOST,
    "x-ca-signature-headers": "X-Ca-Key,X-Ca-Timestamp,X-Ca-Nonce,X-Ca-Signature-Method",
    "x-ca-key": CA_KEY,
    "appversioncode": "4.1.9",
    "token": token || "",
    "x-ca-nonce": nonce,
    "content-type": contentType,
    "authentication": `AppId=${APP_ID}`,
    "accept": accept,
    "authorization": `APPCODE ${APP_CODE}`,
    "appversionname": "40109027",
    "x-ca-signature": signature,
    "referer": H5_HOST + "/",
    "accept-language": "zh-CN,zh-Hans;q=0.9",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 x-cordova-platform/ios cordova-6 appVersionCode/4.1.9 appVersionName/40109027",
    "acl-app": "BUYER",
    "x-ca-timestamp": timestamp,
    "x-ca-signature-method": "HmacSHA256"
  };
}

function logStoredState() {
  const token = read(STORE_TOKEN);
  const svcsid = read(STORE_SVCSID);
  const shareCode = read(STORE_SHARE_CODE);
  const template = read(STORE_SHARE_CODE_HEADERS);
  const usedRaw = read(STORE_USED_IDS) || "[]";

  log("Stored token = " + mask(token, 12, 8));
  log("Stored svcsid = " + mask(svcsid, 12, 8));
  log("Stored shareCode = " + mask(shareCode, 12, 8));
  log("Stored getShareCode template = " + (template ? "yes" : "empty"));
  log("Stored used ids = " + usedRaw);
}

function handleHttpRequest() {
  const url = $request.url || "";
  const headers = $request.headers || {};

  log("HTTP_REQUEST URL = " + url);

  if (url.includes("app-services.lynkco.com.cn/app/v1/task/getShareCode")) {
    write(JSON.stringify(headers), STORE_SHARE_CODE_HEADERS);

    const token = getHeader(headers, "token");
    const svcsid = getHeader(headers, "svcsid");
    const riskInfo = getHeader(headers, "risk_request_info");
    const caKey = getHeader(headers, "x-ca-key");
    const signatureHeaders = getHeader(headers, "x-ca-signature-headers");

    if (token) {
      write(token, STORE_TOKEN);
      log("token saved from getShareCode = " + mask(token, 12, 8));
    }

    if (svcsid) {
      write(svcsid, STORE_SVCSID);
      log("svcsid saved from getShareCode = " + mask(svcsid, 12, 8));
    }

    log("getShareCode x-ca-key = " + caKey);
    log("getShareCode signature headers = " + signatureHeaders);
    log("getShareCode risk_request_info = " + String(riskInfo || "").slice(0, 300));

    notify("LynkCo getShareCode template saved", "Ready for auto shareCode", "OK");
    $done({});
    return;
  }

  const token = getHeader(headers, "token");
  const svcsid = getHeader(headers, "svcsid");

  if (token) {
    write(token, STORE_TOKEN);
    log("token saved = " + mask(token, 12, 8));
  }

  if (svcsid) {
    write(svcsid, STORE_SVCSID);
    log("svcsid saved = " + mask(svcsid, 12, 8));
  }

  if (url.includes("shareCode=")) {
    const m = url.match(/[?&]shareCode=([^&#]+)/);

    if (m && m[1]) {
      const shareCode = decodeURIComponent(m[1]);
      write(shareCode, STORE_SHARE_CODE);
      log("shareCode saved = " + mask(shareCode, 12, 8));
      notify("LynkCo shareCode saved", "Fallback shareCode saved", mask(shareCode, 12, 8));
    }
  } else if (token || svcsid) {
    notify("LynkCo token saved", "Ready for article request", "token/svcsid OK");
  }

  $done({});
}

function extractArticleList(obj) {
  const candidates = [
    obj && obj.data && obj.data.list,
    obj && obj.data && obj.data.records,
    obj && obj.data && obj.data.rows,
    obj && obj.data && obj.data.result,
    obj && obj.data && obj.data.pageData,
    obj && obj.data && obj.data.items,
    obj && obj.data && obj.data.data && obj.data.data.list,
    obj && obj.data && obj.data.data && obj.data.data.records,
    obj && obj.data && obj.data.data && obj.data.data.rows,
    obj && obj.data
  ];

  for (const item of candidates) {
    if (Array.isArray(item)) {
      return item;
    }
  }

  return [];
}

function getArticleId(item) {
  return String(
    item.id ||
    item.newId ||
    item.itemId ||
    item.contentId ||
    item.articleId ||
    item.relaCode ||
    item.businessNo ||
    ""
  );
}

function getTitle(item) {
  return item.title || item.name || item.subject || item.desc || "Unknown title";
}

function getArticleDebugInfo(item, index) {
  if (!item) return `#${index}: empty`;

  return [
    `#${index}`,
    `id=${item.id || ""}`,
    `newId=${item.newId || ""}`,
    `itemId=${item.itemId || ""}`,
    `contentId=${item.contentId || ""}`,
    `articleId=${item.articleId || ""}`,
    `businessNo=${item.businessNo || ""}`,
    `title=${getTitle(item)}`
  ].join(" | ");
}

function logArticleCandidates(list) {
  log("Article total in current page = " + list.length);

  const max = Math.min(list.length, 5);
  for (let i = 0; i < max; i++) {
    log("Candidate article " + getArticleDebugInfo(list[i], i));
  }
}

function pickArticle(list) {
  let used = [];

  try {
    used = JSON.parse(read(STORE_USED_IDS) || "[]");
  } catch (e) {
    used = [];
  }

  log("Used article ids count = " + used.length);
  log("Used article ids = " + JSON.stringify(used));

  for (let i = 0; i < list.length; i++) {
    const id = getArticleId(list[i]);

    if (!id) {
      log("Skip article index " + i + ", reason = empty id");
      continue;
    }

    if (used.includes(id)) {
      log("Skip article index " + i + ", reason = already used, id = " + id);
      continue;
    }

    log("Pick article index = " + i);
    log("Pick article info = " + getArticleDebugInfo(list[i], i));
    return list[i];
  }

  const fallback = list.find(item => getArticleId(item));

  if (fallback) {
    log("All articles in this page may be used, fallback to first valid article");
    log("Fallback article info = " + getArticleDebugInfo(fallback, list.indexOf(fallback)));
  }

  return fallback;
}

function saveUsedArticle(id) {
  let used = [];

  try {
    used = JSON.parse(read(STORE_USED_IDS) || "[]");
  } catch (e) {
    used = [];
  }

  used.unshift(String(id));
  used = Array.from(new Set(used)).slice(0, 50);
  write(JSON.stringify(used), STORE_USED_IDS);

  log("Saved used article id = " + id);
  log("Updated used article ids = " + JSON.stringify(used));
}

function buildShareUrl(articleId) {
  const routeUrl = `/pages/exploration/article/index.js?id=${articleId}`;
  return (
    H5_HOST +
    "/app-h5/dist/web/pages/exploration/article/index.html" +
    "?id=" + articleId +
    "&isShare=" + encodeURIComponent("lynkco://wx/?routeUrl=" + routeUrl)
  );
}

function buildGetShareCodeHeaders(articleId) {
  const raw = read(STORE_SHARE_CODE_HEADERS);

  if (!raw) {
    throw new Error("Missing getShareCode headers template");
  }

  let headers = {};
  try {
    headers = JSON.parse(raw);
  } catch (e) {
    throw new Error("Invalid getShareCode headers template");
  }

  const now = Date.now();
  const openTimeStamp = new Date(now + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  const token = read(STORE_TOKEN);
  const svcsid = read(STORE_SVCSID);

  if (token) setHeader(headers, "token", token);
  if (svcsid) setHeader(headers, "svcsid", svcsid);

  setHeader(headers, "risk_type", "1");
  setHeader(headers, "risk_request_info", JSON.stringify({
    openTimeStamp: openTimeStamp,
    shareContentType: 1,
    shareContentURL: buildShareUrl(articleId)
  }));

  delHeader(headers, ":scheme");
  delHeader(headers, ":authority");
  delHeader(headers, ":path");
  delHeader(headers, ":method");
  delHeader(headers, "host");
  delHeader(headers, "content-length");

  return headers;
}

async function getNewShareCode(articleId) {
  const url = APP_SERVICE_HOST + "/app/v1/task/getShareCode";
  const headers = buildGetShareCodeHeaders(articleId);

  log("Request getShareCode articleId = " + articleId);
  log("getShareCode risk_request_info = " + String(getHeader(headers, "risk_request_info")).slice(0, 400));
  log("getShareCode x-ca-key = " + getHeader(headers, "x-ca-key"));
  log("getShareCode x-ca-signature = " + mask(getHeader(headers, "x-ca-signature"), 8, 8));

  const ret = await request("GET", url, headers);

  log("getShareCode HTTP = " + ret.resp.status);
  log("getShareCode body = " + String(ret.data || "").slice(0, 600));

  let obj = {};
  try {
    obj = JSON.parse(ret.data || "{}");
  } catch (e) {}

  if (Number(ret.resp.status) === 200 && obj.code === "success" && obj.data) {
    write(obj.data, STORE_SHARE_CODE);
    log("new shareCode saved = " + mask(obj.data, 12, 8));
    return obj.data;
  }

  throw new Error("getShareCode failed: " + String(ret.data || ""));
}

async function runCron() {
  log("LynkCo auto share start");
  logStoredState();

  const token = read(STORE_TOKEN);
  const svcsid = read(STORE_SVCSID);
  const shareCodeTemplate = read(STORE_SHARE_CODE_HEADERS);

  log("token = " + (token ? "yes" : "empty"));
  log("svcsid = " + (svcsid ? "yes" : "empty"));
  log("getShareCode template = " + (shareCodeTemplate ? "yes" : "empty"));

  if (!token && !svcsid) {
    notify("LynkCo auto share failed", "Missing token", "打开领克 App 探索文章一次");
    $done({});
    return;
  }

  if (!shareCodeTemplate) {
    notify("LynkCo auto share failed", "Missing getShareCode template", "打开文章后点击分享并复制链接一次");
    $done({});
    return;
  }

  try {
    const listPath = `/app/explore/home-page/v2/page/pull?pageNo=1&pageSize=10&articleTypes=`;
    const listUrl = `${H5_API_HOST}${listPath}`;

    log("Request article list: " + listUrl);

    const listRet = await request(
      "GET",
      listUrl,
      buildH5SignedHeaders("GET", listPath)
    );

    log("Article list HTTP = " + listRet.resp.status);
    log("Article list body = " + String(listRet.data || "").slice(0, 800));

    if (Number(listRet.resp.status) !== 200) {
      notify("LynkCo auto share failed", "Article list HTTP " + listRet.resp.status, String(listRet.data || "{}").slice(0, 150));
      $done({});
      return;
    }

    const listObj = JSON.parse(listRet.data || "{}");
    const list = extractArticleList(listObj);

    log("Article list code = " + (listObj.code || ""));
    log("Article list total = " + ((listObj.data && listObj.data.total) || ""));
    log("Article list page = " + ((listObj.data && listObj.data.page) || ""));
    log("Article list pageSize = " + ((listObj.data && listObj.data.pageSize) || ""));

    logArticleCandidates(list);

    if (!list.length) {
      notify("LynkCo auto share failed", "Empty article list", String(listRet.data || "{}").slice(0, 150));
      $done({});
      return;
    }

    const article = pickArticle(list);

    if (!article) {
      notify("LynkCo auto share failed", "No available article", "");
      $done({});
      return;
    }

    const articleId = getArticleId(article);
    const title = getTitle(article);

    if (!articleId) {
      notify("LynkCo auto share failed", "Cannot parse article ID", JSON.stringify(article).slice(0, 200));
      $done({});
      return;
    }

    log("Selected article raw = " + JSON.stringify(article).slice(0, 800));
    log("Selected article id = " + articleId);
    log("Selected article newId = " + (article.newId || ""));
    log("Selected article itemId = " + (article.itemId || ""));
    log("Selected article contentId = " + (article.contentId || ""));
    log("Selected article articleId = " + (article.articleId || ""));
    log("Selected article businessNo = " + (article.businessNo || ""));
    log("Selected article title = " + title);

    const detailPath = `/app/explore/home-page/article/content/${articleId}?typeCode=content`;
    const detailUrl = `${H5_API_HOST}${detailPath}`;

    log("Detail request articleId = " + articleId);
    log("Request article detail: " + detailUrl);

    const detailRet = await request(
      "GET",
      detailUrl,
      buildH5SignedHeaders("GET", detailPath)
    );

    log("Article detail HTTP = " + detailRet.resp.status);
    log("Article detail body = " + String(detailRet.data || "").slice(0, 300));

    const readPath = `/app/explore/home-page/article/countingservice/add?itemId=${articleId}&types=ReadCount`;
    const readUrl = `${H5_API_HOST}${readPath}`;

    log("ReadCount request itemId = " + articleId);
    log("Request ReadCount: " + readUrl);

    const readRet = await request(
      "POST",
      readUrl,
      buildH5SignedHeaders("POST", readPath),
      {}
    );

    log("ReadCount HTTP = " + readRet.resp.status);
    log("ReadCount body = " + String(readRet.data || "").slice(0, 300));

    const shareCountPath = `/app/explore/home-page/article/countingservice/add?itemId=${articleId}&types=ShareCount`;
    const shareCountUrl = `${H5_API_HOST}${shareCountPath}`;

    log("ShareCount request itemId = " + articleId);
    log("Request ShareCount: " + shareCountUrl);

    const shareCountRet = await request(
      "POST",
      shareCountUrl,
      buildH5SignedHeaders("POST", shareCountPath),
      {}
    );

    log("ShareCount HTTP = " + shareCountRet.resp.status);
    log("ShareCount body = " + String(shareCountRet.data || "").slice(0, 300));

    const freshShareCode = await getNewShareCode(articleId);

    const reportUrl = `${H5_HOST}/app/v1/task/shareReporting?shareCode=${encodeURIComponent(freshShareCode)}`;

    const reportHeaders = {
      "accept": "*/*",
      "content-type": "application/json",
      "origin": H5_HOST,
      "referer": H5_HOST + "/",
      "accept-language": "zh-CN,zh-Hans;q=0.9",
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1"
    };

    const reportBody = {
      businessNo: articleId,
      eventData: {
        firstClassification: "文章",
        secondClassification: ""
      }
    };

    log("shareReporting businessNo = " + articleId);
    log("shareReporting shareCode = " + mask(freshShareCode, 12, 8));
    log("Request shareReporting: " + reportUrl);
    log("shareReporting request body = " + JSON.stringify(reportBody));

    const reportRet = await request(
      "POST",
      reportUrl,
      reportHeaders,
      reportBody
    );

    log("shareReporting HTTP = " + reportRet.resp.status);
    log("shareReporting body = " + String(reportRet.data || "").slice(0, 500));

    let reportObj = {};
    try {
      reportObj = JSON.parse(reportRet.data || "{}");
    } catch (e) {}

    const reportCode = reportObj.code || "";
    const reportData = reportObj.data || "";
    const reportMessage = reportObj.message || "";

    log("shareReporting code = " + reportCode);
    log("shareReporting data = " + reportData);
    log("shareReporting message = " + reportMessage);

    const reportSuccess =
      Number(reportRet.resp.status) === 200 &&
      reportCode === "success" &&
      reportData === "上报成功";

    if (reportSuccess) {
      saveUsedArticle(articleId);
      notify("LynkCo auto share done", articleId, title);
    } else {
      log("shareReporting not completed, do not save used article id");

      if (String(reportData).includes("验证码失效")) {
        notify("LynkCo auto share failed", "shareCode expired", "getShareCode 可能未生成有效新码");
      } else {
        notify("LynkCo auto share failed", `HTTP ${reportRet.resp.status}`, String(reportRet.data || "").slice(0, 200));
      }
    }

    log("LynkCo auto share end");
    $done({});
  } catch (e) {
    log("Script error: " + e);
    notify("LynkCo auto share error", "", String(e));
    $done({});
  }
}

if (typeof $request !== "undefined") {
  handleHttpRequest();
} else {
  runCron();
}