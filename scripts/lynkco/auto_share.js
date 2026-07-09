/*
领克每日签到 + 自动分享脚本
适用：Loon 3.5.0+

核心思路：
1. 参考 sy5t4w-del/lynk_auto_sign：
   - refreshToken + deviceId -> accessToken
   - /up/api/v1/user/sign 签到
   - /app/v1/task/getShareCode 主动获取 shareCode
2. 合并当前 Loon 抓包能力：
   - 自动抓 token / svcsid
   - 自动抓 refreshToken / deviceId
   - 兼容旧 H5 分享任务链路

Loon 插件建议：

[Script]
# 抓 H5 token / svcsid
http-request ^https:\/\/h5-api\.lynkco\.com\/app\/explore\/home-page\/.* script-path=https://raw.githubusercontent.com/swsv/network-toolkit/redpanda/scripts/lynkco/auto_share.js, requires-body=false, timeout=30, tag=领克抓Token

# 抓登录/刷新响应里的 refreshToken，可选但建议保留
http-response ^https:\/\/app-services\.lynkco\.com\.cn\/auth\/login\/.* script-path=https://raw.githubusercontent.com/swsv/network-toolkit/redpanda/scripts/lynkco/auto_share.js, requires-body=true, timeout=30, tag=领克抓RefreshToken

# 可选：被动抓 getShareCode，作为兜底
http-response ^https:\/\/(app-services\.lynkco\.com\.cn|app-api-gw-toc\.lynkco\.com)\/app\/v1\/task\/getShareCode script-path=https://raw.githubusercontent.com/swsv/network-toolkit/redpanda/scripts/lynkco/auto_share.js, requires-body=true, timeout=30, tag=领克抓ShareCode

# 定时执行
cron "23 8,20 * * *" script-path=https://raw.githubusercontent.com/swsv/network-toolkit/redpanda/scripts/lynkco/auto_share.js, timeout=90, tag=领克每日签到分享

[MITM]
hostname = h5-api.lynkco.com, h5.lynkco.com, app-services.lynkco.com.cn, app-api-gw-toc.lynkco.com
*/

const SCRIPT_VERSION = "2026-07-09-loon-merged-sign-share-v1";

/* =========================
 * Store Keys
 * ========================= */
const STORE_TOKEN = "lynkco_token";
const STORE_SVCSID = "lynkco_svcsid";
const STORE_REFRESH_TOKEN = "lynkco_refresh_token";
const STORE_DEVICE_ID = "lynkco_device_id";
const STORE_ACCESS_TOKEN = "lynkco_access_token";
const STORE_ACCESS_TOKEN_DAY = "lynkco_access_token_day";

const STORE_USED_IDS = "lynkco_used_article_ids";

const STORE_SHARE_CODE = "lynkco_share_code";
const STORE_SHARE_CODE_DAY = "lynkco_share_code_day";
const STORE_SHARE_CODE_SOURCE = "lynkco_share_code_source";
const STORE_SHARE_CODE_ARTICLE_ID = "lynkco_share_code_article_id";
const STORE_SHARE_URL = "lynkco_share_url";

/* =========================
 * Constants
 * ========================= */
const APP_CODE = "3fa3314998bd4195a9fe2df3e85e6a12";
const APP_ID = "59701c08ed454a43a9b";

const CA_KEY = "204644386";
const CA_SECRET = "QCl7udM3PB9cOIOwquwPglikFQnzJRsX";

const H5_API_HOST = "https://h5-api.lynkco.com";
const H5_HOST = "https://h5.lynkco.com";
const APP_API_GW_HOST = "https://app-api-gw-toc.lynkco.com";
const OAUTH_HOST = "https://app-services.lynkco.com.cn";

const EP_REFRESH = "/auth/login/refresh";

const EP_DAILY_SIGN = "/up/api/v1/user/sign";
const EP_SIGN_INFO = "/up/api/v1/userReward/getContinueDaysAndSignCard";
const EP_TASK_LIST = "/up/api/v1/userReward/getTaskList";
const EP_ENERGY = "/app/energy/myEnergy";
const EP_GET_SHARE_CODE = "/app/v1/task/getShareCode";

/* =========================
 * Basic Utils
 * ========================= */
function log(msg) {
  console.log("[LynkCo] " + String(msg));
}

function notify(title, sub, msg) {
  log("[Notify] " + title + " | " + (sub || "") + " | " + (msg || ""));
  try {
    $notification.post(title, sub || "", msg || "");
  } catch (e) {}
}

function read(key) {
  return $persistentStore.read(key);
}

function write(value, key) {
  if (value === undefined || value === null || value === "") return false;
  return $persistentStore.write(String(value), key);
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

function parseJsonSafe(text) {
  try {
    return JSON.parse(text || "{}");
  } catch (e) {
    return {};
  }
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
          resp: response || {},
          data: data || ""
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

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function formatGmt8Day(now) {
  const d = new Date((now || Date.now()) + 8 * 60 * 60 * 1000);
  return (
    d.getUTCFullYear() + "-" +
    pad2(d.getUTCMonth() + 1) + "-" +
    pad2(d.getUTCDate())
  );
}

/* =========================
 * URL Utils
 * ========================= */
function parseUrlQuery(url) {
  const out = {};
  const text = String(url || "");
  const idx = text.indexOf("?");
  if (idx < 0) return out;

  const q = text.slice(idx + 1);
  q.split("&").forEach(pair => {
    if (!pair) return;
    const eq = pair.indexOf("=");
    if (eq < 0) {
      out[decodeURIComponent(pair)] = "";
    } else {
      const k = decodeURIComponent(pair.slice(0, eq));
      const v = decodeURIComponent(pair.slice(eq + 1));
      out[k] = v;
    }
  });

  return out;
}

function extractDeviceIdFromUrl(url) {
  const q = parseUrlQuery(url);
  return q.deviceId || q.deviceid || q.gl_dev_id || "";
}

function extractTokenFromObject(obj) {
  if (!obj) return "";

  const paths = [
    obj.refreshToken,
    obj.data && obj.data.refreshToken,
    obj.data && obj.data.centerTokenDto && obj.data.centerTokenDto.refreshToken,
    obj.centerTokenDto && obj.centerTokenDto.refreshToken,
    obj.token && String(obj.token).includes("bearer") ? obj.token : "",
    obj.data && obj.data.token && String(obj.data.token).includes("bearer") ? obj.data.token : ""
  ];

  for (const p of paths) {
    if (p && typeof p === "string") return p;
  }

  return "";
}

function extractAccessTokenFromObject(obj) {
  if (!obj) return "";

  const paths = [
    obj.accessToken,
    obj.data && obj.data.accessToken,
    obj.data && obj.data.centerTokenDto && obj.data.centerTokenDto.token,
    obj.centerTokenDto && obj.centerTokenDto.token,
    obj.token,
    obj.data && obj.data.token
  ];

  for (const p of paths) {
    if (p && typeof p === "string") return p;
  }

  return "";
}

/* =========================
 * SHA256 + HMAC
 * 不依赖 CryptoJS
 * ========================= */
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
  while ((bytes.length % 64) !== 56) bytes.push(0);

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

    let a = H[0], b = H[1], c = H[2], d = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];

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

  while (keyBytes.length < 64) keyBytes.push(0);

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

/* =========================
 * API Gateway Signature
 * 按 lynk_auto_sign 风格
 * ========================= */
function canonicalizePathForSign(pathWithQuery) {
  if (!pathWithQuery.includes("?")) return pathWithQuery;

  const parts = pathWithQuery.split("?");
  const path = parts[0];
  const query = parts.slice(1).join("?");

  if (!query) return path;

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

      return {
        key: decodeURIComponent(item.slice(0, idx)),
        value: decodeURIComponent(item.slice(idx + 1))
      };
    });

  params.sort((a, b) => {
    if (a.key === b.key) return 0;
    return a.key < b.key ? -1 : 1;
  });

  const canonicalQuery = params.map(p => {
    if (p.value === null || p.value === "") return encodeURIComponent(p.key);
    return encodeURIComponent(p.key) + "=" + encodeURIComponent(p.value);
  }).join("&");

  return path + "?" + canonicalQuery;
}

function buildApiSignedHeaders(method, pathWithQuery, token) {
  const timestamp = String(Date.now());
  const nonce = uuid().toUpperCase();

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

  log("Sign " + method.toUpperCase() + " signPath = " + signPath);

  return {
    "token": token || "",
    "content-type": contentType,
    "accept": accept,
    "x-ca-key": CA_KEY,
    "x-ca-nonce": nonce,
    "x-ca-signature-method": "HmacSHA256",
    "x-ca-timestamp": timestamp,
    "x-ca-signature-headers": "X-Ca-Key,X-Ca-Timestamp,X-Ca-Nonce,X-Ca-Signature-Method",
    "x-ca-signature": signature,
    "authorization": `APPCODE ${APP_CODE}`,
    "authentication": `AppId=${APP_ID}`,
    "origin": H5_HOST,
    "referer": H5_HOST + "/",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 x-cordova-platform/ios cordova-6 appVersionCode/4.2.0 appVersionName/40200106",
    "acl-app": "BUYER"
  };
}

function buildH5SignedHeaders(method, pathWithQuery, tokenOverride) {
  const token = tokenOverride || read(STORE_TOKEN) || read(STORE_ACCESS_TOKEN) || "";
  const svcsid = read(STORE_SVCSID) || token;

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

  return {
    "svcsid": svcsid || token || "",
    "origin": H5_HOST,
    "x-ca-signature-headers": "X-Ca-Key,X-Ca-Timestamp,X-Ca-Nonce,X-Ca-Signature-Method",
    "x-ca-key": CA_KEY,
    "appversioncode": "4.2.0",
    "token": token || "",
    "x-ca-nonce": nonce,
    "content-type": contentType,
    "authentication": `AppId=${APP_ID}`,
    "accept": accept,
    "authorization": `APPCODE ${APP_CODE}`,
    "appversionname": "40200106",
    "x-ca-signature": signature,
    "referer": H5_HOST + "/",
    "accept-language": "zh-CN,zh-Hans;q=0.9",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 x-cordova-platform/ios cordova-6 appVersionCode/4.2.0 appVersionName/40200106",
    "acl-app": "BUYER",
    "x-ca-timestamp": timestamp,
    "x-ca-signature-method": "HmacSHA256"
  };
}

/* =========================
 * Token Refresh
 * ========================= */
async function refreshAccessToken() {
  const refreshToken = read(STORE_REFRESH_TOKEN);
  const deviceId = read(STORE_DEVICE_ID);

  if (!refreshToken || !deviceId) {
    log("refreshAccessToken skipped: missing refreshToken/deviceId");
    return "";
  }

  const query =
    "refreshToken=" + encodeURIComponent(refreshToken) +
    "&deviceId=" + encodeURIComponent(deviceId) +
    "&deviceType=IOS" +
    "&appVersion=4.2.0";

  const url = OAUTH_HOST + EP_REFRESH + "?" + query;

  const headers = {
    "Authorization": `APPCODE ${APP_CODE}`,
    "accept": "application/json",
    "content-type": "application/json; charset=UTF-8",
    "publicplatform": "iOS",
    "user-agent": "CA_iOS_SDK_2.0",
    "token": "",
    "gl_dev_id": deviceId,
    "appversioncode": "4.2.0",
    "appversionname": "40200106",
    "gl_app_version": "4.2.0",
    "gl_app_build": "40200106",
    "x-ca-version": "1"
  };

  log("Refresh accessToken start");
  log("Refresh deviceId = " + mask(deviceId, 8, 6));
  log("Refresh refreshToken = " + mask(refreshToken, 12, 8));

  try {
    const ret = await request("GET", url, headers);
    log("Refresh HTTP = " + ret.resp.status);
    log("Refresh body = " + String(ret.data || "").slice(0, 1000));

    if (Number(ret.resp.status) !== 200) return "";

    const obj = parseJsonSafe(ret.data);
    if (String(obj.code || "") !== "success") return "";

    const dto = (obj.data && obj.data.centerTokenDto) || {};
    const accessToken = dto.token || "";
    const newRefreshToken = dto.refreshToken || "";

    if (accessToken) {
      write(accessToken, STORE_ACCESS_TOKEN);
      write(accessToken, STORE_TOKEN);
      write(accessToken, STORE_SVCSID);
      write(formatGmt8Day(Date.now()), STORE_ACCESS_TOKEN_DAY);
      log("accessToken saved = " + mask(accessToken, 12, 8));
    }

    if (newRefreshToken && newRefreshToken !== refreshToken) {
      write(newRefreshToken, STORE_REFRESH_TOKEN);
      log("refreshToken updated = " + mask(newRefreshToken, 12, 8));
    }

    return accessToken;
  } catch (e) {
    log("refreshAccessToken error = " + e);
    return "";
  }
}

async function getBusinessToken() {
  let token = "";

  token = await refreshAccessToken();

  if (token) return token;

  token = read(STORE_ACCESS_TOKEN) || read(STORE_TOKEN) || read(STORE_SVCSID) || "";

  if (token) {
    log("Use fallback token = " + mask(token, 12, 8));
  }

  return token;
}

/* =========================
 * API Business Calls
 * ========================= */
async function apiCall(method, pathWithQuery, token, body) {
  const url = APP_API_GW_HOST + pathWithQuery;
  const headers = buildApiSignedHeaders(method, pathWithQuery, token);

  log("API request " + method + " " + url);

  const ret = await request(method, url, headers, body);
  log("API HTTP = " + ret.resp.status);
  log("API body = " + String(ret.data || "").slice(0, 1000));

  return {
    status: Number(ret.resp.status),
    obj: parseJsonSafe(ret.data),
    raw: ret.data || ""
  };
}

async function doDailySign(token) {
  log("Daily sign start");

  const ret = await apiCall("POST", EP_DAILY_SIGN, token, {});
  const obj = ret.obj || {};
  const allText = JSON.stringify(obj);

  if (ret.status === 200 && String(obj.code || "") === "success") {
    notify("领克签到完成", "", obj.message || allText.slice(0, 120));
    return true;
  }

  if (
    allText.includes("已签到") ||
    allText.includes("已经签到") ||
    allText.includes("今日已") ||
    allText.includes("重复")
  ) {
    notify("领克今日已签到", "", obj.message || allText.slice(0, 120));
    return true;
  }

  notify("领克签到失败", "HTTP " + ret.status, allText.slice(0, 200));
  return false;
}

async function getSignInfo(token) {
  log("Sign info start");

  const ret = await apiCall("GET", EP_SIGN_INFO, token);
  const obj = ret.obj || {};

  if (ret.status !== 200 || String(obj.code || "") !== "success") return;

  const data = obj.data || {};
  const days =
    data.continueDays ||
    data.continuousDays ||
    data.signDays ||
    "";

  const cards =
    data.signCardNumber ||
    data.signCardNum ||
    "";

  log("Sign continue days = " + days);
  log("Sign card number = " + cards);

  if (days !== "" || cards !== "") {
    notify(
      "领克签到信息",
      days !== "" ? "连续签到 " + days + " 天" : "",
      cards !== "" ? "补签卡 " + cards + " 张" : ""
    );
  }
}

async function getTaskList(token) {
  log("Task list start");

  const ret = await apiCall("GET", EP_TASK_LIST, token);
  const obj = ret.obj || {};

  if (ret.status !== 200 || String(obj.code || "") !== "success") return;

  log("Task list body parsed OK");
}

function extractShareCode(obj) {
  if (!obj) return "";
  if (typeof obj.data === "string") return obj.data;
  if (obj.data && typeof obj.data.shareCode === "string") return obj.data.shareCode;
  if (obj.data && typeof obj.data.code === "string") return obj.data.code;
  if (typeof obj.shareCode === "string") return obj.shareCode;
  return "";
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

function buildShareUrlWithCode(articleId, shareCode) {
  return buildShareUrl(articleId) + "&shareCode=" + encodeURIComponent(shareCode);
}

function saveShareCode(shareCode, source, articleId) {
  const day = formatGmt8Day(Date.now());
  let shareUrl = "";

  write(shareCode, STORE_SHARE_CODE);
  write(day, STORE_SHARE_CODE_DAY);
  write(source || "unknown", STORE_SHARE_CODE_SOURCE);

  if (articleId) {
    write(String(articleId), STORE_SHARE_CODE_ARTICLE_ID);
    shareUrl = buildShareUrlWithCode(articleId, shareCode);
    write(shareUrl, STORE_SHARE_URL);
  }

  log("shareCode saved = " + mask(shareCode, 12, 8));
  log("shareCode day = " + day);
  log("shareCode source = " + (source || "unknown"));
  log("shareCode articleId = " + (articleId || ""));
}

function getTodayShareCode() {
  const shareCode = read(STORE_SHARE_CODE);
  const shareCodeDay = read(STORE_SHARE_CODE_DAY);
  const today = formatGmt8Day(Date.now());

  if (shareCode && shareCodeDay === today) {
    log("Use cached shareCode for today = " + mask(shareCode, 12, 8));
    return shareCode;
  }

  return "";
}

async function fetchShareCodeDirect(token) {
  let cached = getTodayShareCode();
  if (cached) return cached;

  log("Direct getShareCode start");

  const ret = await apiCall("GET", EP_GET_SHARE_CODE, token);
  const shareCode = extractShareCode(ret.obj);

  if (ret.status === 200 && shareCode) {
    saveShareCode(shareCode, "direct-api", "");
    notify("领克 shareCode 获取成功", formatGmt8Day(Date.now()), mask(shareCode, 12, 8));
    return shareCode;
  }

  notify("领克 shareCode 获取失败", "HTTP " + ret.status, String(ret.raw || "").slice(0, 200));
  return "";
}

/* =========================
 * Article Share Logic
 * 保留你当前 Loon 脚本跑通的 H5 链路
 * ========================= */
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
    if (Array.isArray(item)) return item;
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
  if (!item) return "#" + index + ": empty";

  return [
    "#" + index,
    "id=" + (item.id || ""),
    "newId=" + (item.newId || ""),
    "itemId=" + (item.itemId || ""),
    "contentId=" + (item.contentId || ""),
    "articleId=" + (item.articleId || ""),
    "businessNo=" + (item.businessNo || ""),
    "title=" + getTitle(item)
  ].join(" | ");
}

function pickArticle(list) {
  let used = [];

  try {
    used = JSON.parse(read(STORE_USED_IDS) || "[]");
  } catch (e) {
    used = [];
  }

  log("Used article ids count = " + used.length);

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

  return list.find(item => getArticleId(item));
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
}

async function doArticleShare(accessToken, shareCode) {
  log("Article share start");

  const listPath = "/app/explore/home-page/v2/page/pull?pageNo=1&pageSize=10&articleTypes=";
  const listUrl = H5_API_HOST + listPath;

  log("Request article list: " + listUrl);

  const listRet = await request(
    "GET",
    listUrl,
    buildH5SignedHeaders("GET", listPath, accessToken)
  );

  log("Article list HTTP = " + listRet.resp.status);
  log("Article list body = " + String(listRet.data || "").slice(0, 1000));

  if (Number(listRet.resp.status) !== 200) {
    notify("领克分享失败", "文章列表 HTTP " + listRet.resp.status, String(listRet.data || "").slice(0, 200));
    return false;
  }

  const listObj = parseJsonSafe(listRet.data);
  const list = extractArticleList(listObj);

  log("Article list code = " + (listObj.code || ""));
  log("Article total in current page = " + list.length);

  if (!list.length) {
    notify("领克分享失败", "文章列表为空", String(listRet.data || "").slice(0, 200));
    return false;
  }

  for (let i = 0; i < Math.min(list.length, 5); i++) {
    log("Candidate article " + getArticleDebugInfo(list[i], i));
  }

  const article = pickArticle(list);
  if (!article) {
    notify("领克分享失败", "没有可用文章", "");
    return false;
  }

  const articleId = getArticleId(article);
  const title = getTitle(article);

  if (!articleId) {
    notify("领克分享失败", "无法解析文章 ID", JSON.stringify(article).slice(0, 200));
    return false;
  }

  log("Selected article id = " + articleId);
  log("Selected article title = " + title);

  const detailPath = "/app/explore/home-page/article/content/" + articleId + "?typeCode=content";
  const detailUrl = H5_API_HOST + detailPath;

  const detailRet = await request(
    "GET",
    detailUrl,
    buildH5SignedHeaders("GET", detailPath, accessToken)
  );

  log("Article detail HTTP = " + detailRet.resp.status);
  log("Article detail body = " + String(detailRet.data || "").slice(0, 500));

  const readPath = "/app/explore/home-page/article/countingservice/add?itemId=" + articleId + "&types=ReadCount";
  const readRet = await request(
    "POST",
    H5_API_HOST + readPath,
    buildH5SignedHeaders("POST", readPath, accessToken),
    {}
  );

  log("ReadCount HTTP = " + readRet.resp.status);
  log("ReadCount body = " + String(readRet.data || "").slice(0, 500));

  const shareCountPath = "/app/explore/home-page/article/countingservice/add?itemId=" + articleId + "&types=ShareCount";
  const shareCountRet = await request(
    "POST",
    H5_API_HOST + shareCountPath,
    buildH5SignedHeaders("POST", shareCountPath, accessToken),
    {}
  );

  log("ShareCount HTTP = " + shareCountRet.resp.status);
  log("ShareCount body = " + String(shareCountRet.data || "").slice(0, 500));

  const fullShareUrl = buildShareUrlWithCode(articleId, shareCode);
  write(fullShareUrl, STORE_SHARE_URL);
  write(articleId, STORE_SHARE_CODE_ARTICLE_ID);

  log("Selected article shareUrl with code = " + fullShareUrl);

  const reportUrl = H5_HOST + "/app/v1/task/shareReporting?shareCode=" + encodeURIComponent(shareCode);

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
  log("shareReporting shareCode = " + mask(shareCode, 12, 8));
  log("Request shareReporting: " + reportUrl);

  const reportRet = await request("POST", reportUrl, reportHeaders, reportBody);

  log("shareReporting HTTP = " + reportRet.resp.status);
  log("shareReporting body = " + String(reportRet.data || "").slice(0, 1000));

  const reportObj = parseJsonSafe(reportRet.data);

  const success =
    Number(reportRet.resp.status) === 200 &&
    String(reportObj.code || "") === "success" &&
    String(reportObj.data || "").includes("上报成功");

  if (success) {
    saveUsedArticle(articleId);
    notify("领克分享完成", articleId, title);
    return true;
  }

  notify("领克分享失败", "HTTP " + reportRet.resp.status, String(reportRet.data || "").slice(0, 200));
  return false;
}

/* =========================
 * Passive Capture
 * ========================= */
function isGetShareCodeUrl(url) {
  const text = String(url || "");
  return (
    text.includes("/app/v1/task/getShareCode") &&
    (
      text.includes("app-services.lynkco.com.cn") ||
      text.includes("app-api-gw-toc.lynkco.com")
    )
  );
}

function extractArticleIdFromRiskRequestInfo(headers) {
  const raw = getHeader(headers, "risk_request_info");
  if (!raw) return "";

  try {
    const info = JSON.parse(raw);
    const url = String(info.shareContentURL || "");
    const match = url.match(/[?&]id=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch (e) {
    const match = String(raw).match(/[?&]id=([^&"}]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

function handleHttpRequest() {
  const url = $request.url || "";
  const headers = $request.headers || {};

  log("HTTP_REQUEST URL = " + url);
  log("SCRIPT_VERSION = " + SCRIPT_VERSION);

  const token = getHeader(headers, "token");
  const svcsid = getHeader(headers, "svcsid");
  const deviceId =
    getHeader(headers, "gl_dev_id") ||
    getHeader(headers, "deviceId") ||
    extractDeviceIdFromUrl(url);

  if (token) {
    write(token, STORE_TOKEN);
    log("token saved = " + mask(token, 12, 8));
  }

  if (svcsid) {
    write(svcsid, STORE_SVCSID);
    log("svcsid saved = " + mask(svcsid, 12, 8));
  }

  if (deviceId) {
    write(deviceId, STORE_DEVICE_ID);
    log("deviceId saved = " + mask(deviceId, 8, 6));
  }

  if (token || svcsid || deviceId) {
    notify("领克抓包成功", "token/svcsid/deviceId", "已更新本地缓存");
  }

  $done({});
}

function handleHttpResponse() {
  const url = ($request && $request.url) || "";
  const reqHeaders = ($request && $request.headers) || {};
  const body = ($response && $response.body) || "";

  log("HTTP_RESPONSE URL = " + url);
  log("SCRIPT_VERSION = " + SCRIPT_VERSION);

  const deviceId =
    getHeader(reqHeaders, "gl_dev_id") ||
    getHeader(reqHeaders, "deviceId") ||
    extractDeviceIdFromUrl(url);

  if (deviceId) {
    write(deviceId, STORE_DEVICE_ID);
    log("deviceId saved from response request = " + mask(deviceId, 8, 6));
  }

  const obj = parseJsonSafe(body);

  if (url.includes("/auth/login/")) {
    const refreshToken = extractTokenFromObject(obj);
    const accessToken = extractAccessTokenFromObject(obj);

    if (refreshToken) {
      write(refreshToken, STORE_REFRESH_TOKEN);
      log("refreshToken saved = " + mask(refreshToken, 12, 8));
    }

    if (accessToken) {
      write(accessToken, STORE_ACCESS_TOKEN);
      write(accessToken, STORE_TOKEN);
      write(accessToken, STORE_SVCSID);
      write(formatGmt8Day(Date.now()), STORE_ACCESS_TOKEN_DAY);
      log("accessToken saved = " + mask(accessToken, 12, 8));
    }

    if (refreshToken || accessToken || deviceId) {
      notify("领克登录信息已保存", "refreshToken/deviceId", "后续可自动签到");
    }

    $done({});
    return;
  }

  if (isGetShareCodeUrl(url)) {
    const token = getHeader(reqHeaders, "token");
    const svcsid = getHeader(reqHeaders, "svcsid");

    if (token) {
      write(token, STORE_TOKEN);
      log("token saved from getShareCode = " + mask(token, 12, 8));
    }

    if (svcsid) {
      write(svcsid, STORE_SVCSID);
      log("svcsid saved from getShareCode = " + mask(svcsid, 12, 8));
    }

    log("getShareCode response body = " + String(body || "").slice(0, 1200));

    const shareCode = extractShareCode(obj);
    const articleId = extractArticleIdFromRiskRequestInfo(reqHeaders);

    if (shareCode) {
      saveShareCode(shareCode, "http-response", articleId);
      notify("领克 shareCode 已保存", formatGmt8Day(Date.now()), mask(shareCode, 12, 8));
    }

    $done({});
    return;
  }

  $done({});
}

/* =========================
 * State Log
 * ========================= */
function logStoredState() {
  log("Stored refreshToken = " + mask(read(STORE_REFRESH_TOKEN), 12, 8));
  log("Stored deviceId = " + mask(read(STORE_DEVICE_ID), 8, 6));
  log("Stored accessToken = " + mask(read(STORE_ACCESS_TOKEN), 12, 8));
  log("Stored token = " + mask(read(STORE_TOKEN), 12, 8));
  log("Stored svcsid = " + mask(read(STORE_SVCSID), 12, 8));
  log("Stored shareCode = " + mask(read(STORE_SHARE_CODE), 12, 8));
  log("Stored shareCode day = " + (read(STORE_SHARE_CODE_DAY) || "empty"));
  log("Stored shareCode source = " + (read(STORE_SHARE_CODE_SOURCE) || "empty"));
  log("Stored used ids = " + (read(STORE_USED_IDS) || "[]"));
}

/* =========================
 * Cron Main
 * ========================= */
async function runCron() {
  log("LynkCo sign + share start");
  log("SCRIPT_VERSION = " + SCRIPT_VERSION);
  logStoredState();

  try {
    const token = await getBusinessToken();

    if (!token) {
      notify(
        "领克任务失败",
        "缺少 token",
        "请打开领克 App 登录/探索页，让 Loon 抓 refreshToken/deviceId"
      );
      $done({});
      return;
    }

    log("Business token = " + mask(token, 12, 8));

    await doDailySign(token);
    await getSignInfo(token);
    await getTaskList(token);

    const shareCode = await fetchShareCodeDirect(token);

    if (!shareCode) {
      notify("领克分享跳过", "shareCode 获取失败", "签到已尝试完成，请看日志");
      $done({});
      return;
    }

    await doArticleShare(token, shareCode);

    log("LynkCo sign + share end");
    $done({});
  } catch (e) {
    log("Cron error = " + e);
    notify("领克脚本异常", "", String(e));
    $done({});
  }
}

/* =========================
 * Entry
 * ========================= */
if (typeof $response !== "undefined" && typeof $request !== "undefined") {
  handleHttpResponse();
} else if (typeof $request !== "undefined") {
  handleHttpRequest();
} else {
  runCron();
}
