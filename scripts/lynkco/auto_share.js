/*
领克每日自动分享脚本
适用：Loon 3.3.9

功能说明：
1. 自动抓取 token / svcsid。
2. 自动抓取 shareCode。
3. 定时从探索页获取文章列表。
4. 自动选择一篇未分享过的文章。
5. 自动请求文章详情，相当于进入文章。
6. 自动上报 ReadCount。
7. 自动上报 ShareCount。
8. 自动调用 shareReporting，完成 Co 积分分享任务。

Loon 插件配置：

[Script]
http-request ^https:\/\/h5-api\.lynkco\.com\/app\/explore\/home-page\/.* script-path=lynkco_auto_share.js, requires-body=false, timeout=30, tag=领克抓Token
http-request ^https:\/\/h5\.lynkco\.com\/.*shareCode= script-path=lynkco_auto_share.js, requires-body=false, timeout=30, tag=领克抓ShareCode
cron "50 11 * * *" script-path=lynkco_auto_share.js, timeout=60, tag=领克每日自动分享

[MITM]
hostname = h5-api.lynkco.com, h5.lynkco.com

首次使用步骤：
1. 打开 Loon，开启代理。
2. 开启 MITM，并安装、信任 Loon 证书。
3. 打开领克 App → 探索 → 随便点进一篇文章。
   这一步用于抓取当前账号的 token / svcsid。
4. 在文章页面点击分享 → 复制链接。
5. 把复制出来的分享链接粘贴到 Safari 打开一次。
   这一步用于抓取当前账号的 shareCode。
6. token / svcsid / shareCode 都抓到后，后续就可以自动执行。

日常使用：
1. 初始化完成后，不需要每天手动打开文章。
2. 脚本会每天按照 cron 时间自动执行。
3. 默认执行时间是每天 11:50。
4. 脚本会自动获取探索文章列表，并选择一篇未使用过的文章完成分享上报。
5. 每次成功执行后，会记录本次使用过的文章 ID，后续优先跳过已使用文章。

关于账号数据：
1. token / svcsid / shareCode 都是当前账号自己的数据。
2. 每个使用者都需要用自己的领克账号完成首次初始化。
3. 不要直接使用别人已经抓好的 token / svcsid / shareCode。
4. 脚本本身可以分享，但账号抓取数据不要共用。

关于 shareCode：
1. shareCode 通常只需要初始化一次。
2. 每天变化的是文章 ID，也就是 articleId / businessNo。
3. 脚本每天会自动换新的文章 ID / businessNo。
4. 如果 shareReporting 返回非 success，再重新复制一次文章分享链接并用 Safari 打开，刷新 shareCode。

如果后续失败：
请发执行log给我
*/

const STORE_TOKEN = "lynkco_token";
const STORE_SVCSID = "lynkco_svcsid";
const STORE_SHARE_CODE = "lynkco_share_code";
const STORE_USED_IDS = "lynkco_used_article_ids";

const APP_CODE = "3fa3314998bd4195a9fe2df3e85e6a12";
const APP_ID = "59701c08ed454a43a9b";
const CA_KEY = "204644386";
const CA_SECRET = "QCl7udM3PB9cOIOwquwPglikFQnzJRsX";

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

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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

function buildSignedHeaders(method, pathWithQuery) {
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
    "origin": "https://h5.lynkco.com",
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
    "referer": "https://h5.lynkco.com/",
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
  const usedRaw = read(STORE_USED_IDS) || "[]";

  log("Stored token = " + mask(token, 12, 8));
  log("Stored svcsid = " + mask(svcsid, 12, 8));
  log("Stored shareCode = " + mask(shareCode, 12, 8));
  log("Stored used ids = " + usedRaw);
}

function handleHttpRequest() {
  const url = $request.url || "";
  const headers = $request.headers || {};

  log("HTTP_REQUEST URL = " + url);

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
      notify("LynkCo shareCode saved", "Ready for auto run", mask(shareCode, 12, 8));
    } else {
      notify("LynkCo shareCode failed", "Cannot parse shareCode", url.slice(0, 100));
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

async function runCron() {
  log("LynkCo auto share start");
  logStoredState();

  const token = read(STORE_TOKEN);
  const svcsid = read(STORE_SVCSID);
  const shareCode = read(STORE_SHARE_CODE);

  log("token = " + (token ? "yes" : "empty"));
  log("svcsid = " + (svcsid ? "yes" : "empty"));
  log("shareCode = " + (shareCode ? "yes" : "empty"));

  if (!token && !svcsid) {
    notify("LynkCo auto share failed", "Missing token", "Open LynkCo App article once");
    $done({});
    return;
  }

  if (!shareCode) {
    notify("LynkCo auto share failed", "Missing shareCode", "Copy article share link and open it in Safari once");
    $done({});
    return;
  }

  try {
    const listPath = `/app/explore/home-page/v2/page/pull?pageNo=1&pageSize=10&articleTypes=`;
    const listUrl = `https://h5-api.lynkco.com${listPath}`;

    log("Request article list: " + listUrl);

    const listRet = await request(
      "GET",
      listUrl,
      buildSignedHeaders("GET", listPath)
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
    const detailUrl = `https://h5-api.lynkco.com${detailPath}`;

    log("Detail request articleId = " + articleId);
    log("Request article detail: " + detailUrl);

    const detailRet = await request(
      "GET",
      detailUrl,
      buildSignedHeaders("GET", detailPath)
    );

    log("Article detail HTTP = " + detailRet.resp.status);
    log("Article detail body = " + String(detailRet.data || "").slice(0, 300));

    const readPath = `/app/explore/home-page/article/countingservice/add?itemId=${articleId}&types=ReadCount`;
    const readUrl = `https://h5-api.lynkco.com${readPath}`;

    log("ReadCount request itemId = " + articleId);
    log("Request ReadCount: " + readUrl);

    const readRet = await request(
      "POST",
      readUrl,
      buildSignedHeaders("POST", readPath),
      {}
    );

    log("ReadCount HTTP = " + readRet.resp.status);
    log("ReadCount body = " + String(readRet.data || "").slice(0, 300));

    const shareCountPath = `/app/explore/home-page/article/countingservice/add?itemId=${articleId}&types=ShareCount`;
    const shareCountUrl = `https://h5-api.lynkco.com${shareCountPath}`;

    log("ShareCount request itemId = " + articleId);
    log("Request ShareCount: " + shareCountUrl);

    const shareCountRet = await request(
      "POST",
      shareCountUrl,
      buildSignedHeaders("POST", shareCountPath),
      {}
    );

    log("ShareCount HTTP = " + shareCountRet.resp.status);
    log("ShareCount body = " + String(shareCountRet.data || "").slice(0, 300));

    const reportUrl = `https://h5.lynkco.com/app/v1/task/shareReporting?shareCode=${encodeURIComponent(shareCode)}`;

    const reportHeaders = {
      "accept": "*/*",
      "content-type": "application/json",
      "origin": "https://h5.lynkco.com",
      "referer": "https://h5.lynkco.com/",
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
    log("shareReporting shareCode = " + mask(shareCode, 12, 8));
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

    if (reportObj.code === "success") {
      saveUsedArticle(articleId);
      notify("LynkCo auto share done", articleId, title);
    } else {
      notify("LynkCo auto share maybe failed", `HTTP ${reportRet.resp.status}`, String(reportRet.data || "").slice(0, 200));
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
