/*
领克每日签到与分享链路诊断
适用：Loon 3.2.1+ / 3.5.0+

功能定位：
1. 账号凭证生命周期监测：抓取并管理 /auth/login/refresh 登录凭证，支持长效 Token 自动巡检与续期诊断。
2. 每日签到与任务进度巡检：检测每日签到状态、连签天数、补签卡库存及阶段成长任务完成度。
3. 文章分享链路连通性诊断：巡检探索文章接口，全链路测试 ReadCount / ShareCount / shareReporting 上报通道。
4. 诊断报告多端推送：集成 PushPlus 微信通知与系统本地通知，生成立体化诊断卡片。
*/

const SCRIPT_VERSION = "2026-09-01-loon-refresh-sign-share-pushplus-v4";

/* =========================
 * LPX Plugin Arguments & PushPlus
 * ========================= */
const rawArg = typeof $argument !== "undefined" ? $argument : null;

function parseAllArgs() {
  const result = {
    pushToken: "",
    pushTopic: "",
    notifyOnSuccess: true
  };

  if (!rawArg) return result;

  if (Array.isArray(rawArg)) {
    if (rawArg.length > 0 && rawArg[0] !== undefined && rawArg[0] !== null) result.pushToken = String(rawArg[0]).trim();
    if (rawArg.length > 1 && rawArg[1] !== undefined && rawArg[1] !== null) result.pushTopic = String(rawArg[1]).trim();
    if (rawArg.length > 2 && rawArg[2] !== undefined && rawArg[2] !== null) {
      const v = rawArg[2];
      result.notifyOnSuccess = typeof v === "boolean" ? v : (String(v).toLowerCase() === "true" || String(v) === "1");
    }
    return result;
  }

  if (typeof rawArg === "object") {
    if (rawArg.pushToken !== undefined && rawArg.pushToken !== null) result.pushToken = String(rawArg.pushToken).trim();
    if (rawArg.pushTopic !== undefined && rawArg.pushTopic !== null) result.pushTopic = String(rawArg.pushTopic).trim();
    if (rawArg.notifyOnSuccess !== undefined && rawArg.notifyOnSuccess !== null) {
      const v = rawArg.notifyOnSuccess;
      result.notifyOnSuccess = typeof v === "boolean" ? v : (String(v).toLowerCase() === "true" || String(v) === "1");
    }
    return result;
  }

  if (typeof rawArg === "string") {
    try {
      const parsed = JSON.parse(rawArg);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && parsed[0]) result.pushToken = String(parsed[0]).trim();
        if (parsed.length > 1 && parsed[1]) result.pushTopic = String(parsed[1]).trim();
        if (parsed.length > 2 && parsed[2] !== undefined) result.notifyOnSuccess = String(parsed[2]).toLowerCase() === "true" || String(parsed[2]) === "1";
        return result;
      }
      if (typeof parsed === "object" && parsed !== null) {
        if (parsed.pushToken) result.pushToken = String(parsed.pushToken).trim();
        if (parsed.pushTopic) result.pushTopic = String(parsed.pushTopic).trim();
        if (parsed.notifyOnSuccess !== undefined) result.notifyOnSuccess = String(parsed.notifyOnSuccess).toLowerCase() === "true" || String(parsed.notifyOnSuccess) === "1";
        return result;
      }
    } catch (e) {}

    let str = rawArg.trim();
    if (str.startsWith("[") && str.endsWith("]")) {
      str = str.slice(1, -1);
    }
    const parts = str.split(",");
    if (parts.length > 0 && parts[0].trim()) result.pushToken = parts[0].trim();
    if (parts.length > 1 && parts[1].trim()) result.pushTopic = parts[1].trim();
    if (parts.length > 2 && parts[2].trim()) result.notifyOnSuccess = parts[2].trim().toLowerCase() === "true" || parts[2].trim() === "1";
  }

  return result;
}

const parsedPluginArgs = parseAllArgs();
const pushToken = parsedPluginArgs.pushToken || (typeof $persistentStore !== "undefined" ? ($persistentStore.read("pushToken") || $persistentStore.read("pushplus_token") || "") : "");
const pushTopic = parsedPluginArgs.pushTopic || (typeof $persistentStore !== "undefined" ? ($persistentStore.read("pushTopic") || "") : "");
const notifyOnSuccess = parsedPluginArgs.notifyOnSuccess;
const pushUrl = "https://www.pushplus.plus/send";

const pushSummary = {
  timeStr: "",
  allSuccess: true,
  tokenStatus: "待刷新",
  signStatus: "未签到",
  signDetail: "",
  continueDays: "0",
  signCardNumber: "0",
  taskList: [],
  articleTitle: "",
  articleId: "",
  readCountStatus: "未执行",
  shareCountStatus: "未执行",
  shareReporting: "未执行",
  errors: []
};

/* =========================
 * Store Keys
 * ========================= */
const STORE_TOKEN = "lynkco_token";
const STORE_SVCSID = "lynkco_svcsid";
const STORE_REFRESH_TOKEN = "lynkco_refresh_token";
const STORE_DEVICE_ID = "lynkco_device_id";
const STORE_GL_DEV_ID = "lynkco_gl_dev_id";
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

const APP_VERSION = "4.2.6";
const APP_BUILD = "40206033";

const EP_REFRESH = "/auth/login/refresh";
const EP_DAILY_SIGN = "/up/api/v1/user/sign/upgrade";
const EP_SIGN_DAY_INFO = "/up/api/v1/user/sign/day/info";
const EP_SIGN_CALENDAR = "/up/api/v1/user/sign/sign/info";
const EP_SIGN_INFO = "/up/api/v1/userReward/getContinueDaysAndSignCard";
const EP_TASK_LIST = "/up/api/v1/userReward/getTaskList";
const EP_GET_SHARE_CODE = "/app/v1/task/getShareCode";

/* =========================
 * Basic Utils
 * ========================= */
function log(msg) {
  console.log("[LynkCo] " + String(msg));
}

function notify(title, sub, msg) {
  log("[Notify] " + title + " | " + (sub || "") + " | " + (msg || ""));
  if (notifyOnSuccess) {
    try {
      $notification.post(title, sub || "", msg || "");
    } catch (e) {}
  }
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

    const cb = function (error, response, data) {
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
      $httpClient.get(opts, cb);
    } else {
      $httpClient.post(opts, cb);
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

function formatGmt8Time(now) {
  const d = new Date((now || Date.now()) + 8 * 60 * 60 * 1000);
  return (
    d.getUTCFullYear() + "-" +
    pad2(d.getUTCMonth() + 1) + "-" +
    pad2(d.getUTCDate()) + " " +
    pad2(d.getUTCHours()) + ":" +
    pad2(d.getUTCMinutes()) + ":" +
    pad2(d.getUTCSeconds())
  );
}

function parseUrlQuery(url) {
  const out = {};
  const text = String(url || "");
  const idx = text.indexOf("?");
  if (idx < 0) return out;

  text.slice(idx + 1).split("&").forEach(pair => {
    if (!pair) return;
    const eq = pair.indexOf("=");
    if (eq < 0) {
      out[decodeURIComponent(pair)] = "";
    } else {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  });

  return out;
}

function isApiSuccess(ret) {
  const obj = ret.obj || {};
  const code = String(obj.code || "");

  return (
    ret.status === 200 &&
    (
      code === "success" ||
      code === "200" ||
      obj.success === true
    )
  );
}

/* =========================
 * Deep Extract
 * ========================= */
function deepFindKey(obj, keyNames) {
  if (!obj || typeof obj !== "object") return "";

  const lowerNames = keyNames.map(k => k.toLowerCase());

  for (const k of Object.keys(obj)) {
    if (lowerNames.includes(k.toLowerCase())) {
      const v = obj[k];
      if (typeof v === "string" && v) return v;
    }
  }

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const found = deepFindKey(v, keyNames);
      if (found) return found;
    }
  }

  return "";
}

function extractRefreshTokenFromBody(obj) {
  return deepFindKey(obj, ["refreshToken", "refresh_token"]);
}

function extractAccessTokenFromBody(obj) {
  const dto = obj && obj.data && obj.data.centerTokenDto;
  if (dto && typeof dto.token === "string") return dto.token;

  return deepFindKey(obj, ["accessToken", "access_token", "token"]);
}

function extractDeviceInfoFromUrlOrHeaders(url, headers) {
  const q = parseUrlQuery(url);

  const queryDeviceId =
    q.deviceId ||
    q.deviceid ||
    "";

  const glDevId =
    getHeader(headers, "gl_dev_id") ||
    getHeader(headers, "glDevId") ||
    "";

  const headerDeviceId =
    getHeader(headers, "deviceId") ||
    getHeader(headers, "deviceid") ||
    "";

  return {
    deviceId: queryDeviceId || headerDeviceId || glDevId || "",
    glDevId: glDevId || headerDeviceId || queryDeviceId || ""
  };
}

/* =========================
 * SHA256 + HMAC
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

  if (keyBytes.length > 64) keyBytes = sha256Bytes(keyBytes);
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
 * Signature
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

function buildSignedHeaders(method, pathWithQuery, token) {
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

  log("Sign " + method.toUpperCase() + " signPath = " + signPath);

  return {
    "token": token || "",
    "svcsid": token || "",
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
    "accept-language": "zh-CN,zh-Hans;q=0.9",
    "acl-app": "BUYER",
    "appversioncode": APP_VERSION,
    "appversionname": APP_BUILD,
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 x-cordova-platform/ios cordova-6 appVersionCode/" + APP_VERSION + " appVersionName/" + APP_BUILD
  };
}

/* =========================
 * RefreshToken -> AccessToken
 * ========================= */
async function refreshAccessTokenStrict() {
  const refreshToken = read(STORE_REFRESH_TOKEN);
  const deviceId = read(STORE_DEVICE_ID);
  const glDevId = read(STORE_GL_DEV_ID) || deviceId;

  if (!refreshToken || !deviceId) {
    log("refreshAccessTokenStrict failed: missing refreshToken/deviceId");
    notify("领克凭证缺失", "缺少 refreshToken/deviceId", "请打开 App 等待 /auth/login/refresh，必要时重新登录");
    return "";
  }

  const query =
    "refreshToken=" + encodeURIComponent(refreshToken) +
    "&deviceId=" + encodeURIComponent(deviceId) +
    "&deviceType=IOS" +
    "&appVersion=" + encodeURIComponent(APP_VERSION);

  const url = OAUTH_HOST + EP_REFRESH + "?" + query;

  const headers = {
    "Authorization": `APPCODE ${APP_CODE}`,
    "accept": "application/json",
    "content-type": "application/json; charset=UTF-8",
    "publicplatform": "iOS",
    "user-agent": "CA_iOS_SDK_2.0",
    "token": read(STORE_TOKEN) || "",
    "gl_dev_id": glDevId,
    "appversioncode": APP_VERSION,
    "appversionname": APP_BUILD,
    "gl_app_version": APP_VERSION,
    "gl_app_build": APP_BUILD,
    "x-ca-version": "1"
  };

  log("Refresh accessToken start");
  log("Refresh deviceId = " + mask(deviceId, 8, 6));
  log("Refresh gl_dev_id = " + mask(glDevId, 8, 6));
  log("Refresh refreshToken = " + mask(refreshToken, 12, 8));

  try {
    const ret = await request("GET", url, headers);

    log("Refresh HTTP = " + ret.resp.status);
    log("Refresh body = " + String(ret.data || "").slice(0, 1200));

    if (Number(ret.resp.status) !== 200) return "";

    const obj = parseJsonSafe(ret.data);

    if (String(obj.code || "") !== "success") {
      log("Refresh failed code = " + String(obj.code || ""));
      return "";
    }

    const dto = (obj.data && obj.data.centerTokenDto) || {};
    const accessToken = dto.token || "";
    const newRefreshToken = dto.refreshToken || "";

    if (!accessToken) {
      log("Refresh success but accessToken empty");
      return "";
    }

    write(accessToken, STORE_ACCESS_TOKEN);
    write(accessToken, STORE_TOKEN);
    write(accessToken, STORE_SVCSID);
    write(formatGmt8Day(Date.now()), STORE_ACCESS_TOKEN_DAY);

    if (newRefreshToken) {
      write(newRefreshToken, STORE_REFRESH_TOKEN);
      log("refreshToken updated = " + mask(newRefreshToken, 12, 8));
    }

    log("accessToken saved = " + mask(accessToken, 12, 8));
    return accessToken;
  } catch (e) {
    log("refreshAccessTokenStrict error = " + e);
    return "";
  }
}

/* =========================
 * API Calls
 * ========================= */
async function apiCall(method, pathWithQuery, token, body) {
  const url = APP_API_GW_HOST + pathWithQuery;

  log("API request " + method + " " + url);

  const ret = await request(
    method,
    url,
    buildSignedHeaders(method, pathWithQuery, token),
    body
  );

  log("API HTTP = " + ret.resp.status);
  log("API body = " + String(ret.data || "").slice(0, 1200));

  return {
    status: Number(ret.resp.status),
    obj: parseJsonSafe(ret.data),
    raw: ret.data || ""
  };
}

async function doDailySign(token) {
  log("Daily sign start");

  // 1. 先查询今日签到状态
  const dayRet = await apiCall("GET", EP_SIGN_DAY_INFO, token);
  const dayObj = dayRet.obj || {};
  if (dayRet.status === 200 && dayObj.data && Number(dayObj.data.signStatus) === 1) {
    log("Today already signed in (signStatus=1)");
    notify("领克今日已签到", "", "今日已完成签到");
    pushSummary.signStatus = "✔ 今日已签到";
    pushSummary.signDetail = "已确认完成今日签到";
    return true;
  }

  // 2. 执行签到
  log("Executing sign request: " + EP_DAILY_SIGN);
  const ret = await apiCall("POST", EP_DAILY_SIGN, token, {});
  const obj = ret.obj || {};
  const code = String(obj.code || "");
  const text = JSON.stringify(obj);

  // 3. 同步日历
  try {
    const nowTs = Date.now();
    const calBody = { startDate: nowTs - 5 * 86400000, endDate: nowTs + 30 * 86400000 };
    await apiCall("POST", EP_SIGN_CALENDAR, token, calBody);
  } catch (e) {}

  const signSuccess =
    ret.status === 200 &&
    (
      code === "success" ||
      code === "200" ||
      obj.success === true ||
      text.includes("签到成功") ||
      text.includes("操作成功") ||
      (obj.data && obj.data.todayFirstSign === true)
    );

  if (signSuccess) {
    const data = obj.data || {};
    const tip = data.messageTip || obj.message || "签到成功";
    const reward = data.rewardEnergyNumber ? "奖励 " + data.rewardEnergyNumber + " 能量体" : "";
    notify("领克签到完成", tip, reward);
    pushSummary.signStatus = "✔ 签到成功";
    pushSummary.signDetail = tip + (reward ? " (" + reward + ")" : "");
    return true;
  }

  if (
    text.includes("已签到") ||
    text.includes("已经签到") ||
    text.includes("今日已") ||
    text.includes("重复") ||
    (obj.data && obj.data.todayFirstSign === false)
  ) {
    const tip = obj.message || (obj.data && obj.data.messageTip) || "今日已签到";
    notify("领克今日已签到", "", tip);
    pushSummary.signStatus = "✔ 今日已签到";
    pushSummary.signDetail = tip;
    return true;
  }

  // 4. 二次复查 signStatus
  const checkRet = await apiCall("GET", EP_SIGN_DAY_INFO, token);
  if (checkRet.status === 200 && checkRet.obj && checkRet.obj.data && Number(checkRet.obj.data.signStatus) === 1) {
    notify("领克今日已签到", "", "已确认完成今日签到");
    pushSummary.signStatus = "✔ 今日已签到";
    pushSummary.signDetail = "已确认完成今日签到";
    return true;
  }

  notify("领克签到失败", "HTTP " + ret.status, text.slice(0, 200));
  pushSummary.signStatus = "❌ 签到失败";
  pushSummary.signDetail = "HTTP " + ret.status;
  return false;
}

async function getSignInfo(token) {
  log("Sign info start");

  const ret = await apiCall("GET", EP_SIGN_INFO, token);
  const obj = ret.obj || {};

  if (!isApiSuccess(ret)) return;

  const data = obj.data || {};
  const days = String(data.continueDays || data.continuousDays || data.signDays || "0");
  const cards = String(data.signCardNumber || data.signCardNum || "0");

  log("Sign continue days = " + days);
  log("Sign card number = " + cards);
  pushSummary.continueDays = days;
  pushSummary.signCardNumber = cards;
}

async function getTaskList(token) {
  log("Task list start");

  const ret = await apiCall("GET", EP_TASK_LIST, token);

  if (isApiSuccess(ret) && Array.isArray(ret.obj.data)) {
    log("Task list OK");
    pushSummary.taskList = ret.obj.data.map(item => {
      const reward = Array.isArray(item.rewardContent) ? item.rewardContent.join(", ") : "";
      return {
        name: item.taskName,
        process: item.taskProcess,
        reward: reward
      };
    });
  }
}

function extractShareCode(obj) {
  if (!obj) return "";
  if (typeof obj.data === "string") return obj.data;
  if (obj.data && typeof obj.data.shareCode === "string") return obj.data.shareCode;
  if (obj.data && typeof obj.data.code === "string") return obj.data.code;
  if (typeof obj.shareCode === "string") return obj.shareCode;
  return "";
}

async function fetchShareCodeDirect(token) {
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
 * ShareCode / Article Utils
 * ========================= */
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

async function doArticleShare(token, shareCode) {
  log("Article share start");

  const listPath = "/app/explore/home-page/v2/page/pull?pageNo=1&pageSize=10&articleTypes=";
  const listUrl = H5_API_HOST + listPath;

  log("Request article list: " + listUrl);

  const listRet = await request(
    "GET",
    listUrl,
    buildSignedHeaders("GET", listPath, token)
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

  pushSummary.articleId = articleId;
  pushSummary.articleTitle = title || "领克探索文章";

  const detailPath = "/app/explore/home-page/article/content/" + articleId + "?typeCode=content";

  const detailRet = await request(
    "GET",
    H5_API_HOST + detailPath,
    buildSignedHeaders("GET", detailPath, token)
  );

  log("Article detail HTTP = " + detailRet.resp.status);
  log("Article detail body = " + String(detailRet.data || "").slice(0, 500));

  const readPath = "/app/explore/home-page/article/countingservice/add?itemId=" + articleId + "&types=ReadCount";

  const readRet = await request(
    "POST",
    H5_API_HOST + readPath,
    buildSignedHeaders("POST", readPath, token),
    {}
  );

  log("ReadCount HTTP = " + readRet.resp.status);
  log("ReadCount body = " + String(readRet.data || "").slice(0, 500));
  pushSummary.readCountStatus = (Number(readRet.resp.status) === 200 ? "✔ ReadCount 成功" : "❌ 失败 (HTTP " + readRet.resp.status + ")");

  const shareCountPath = "/app/explore/home-page/article/countingservice/add?itemId=" + articleId + "&types=ShareCount";

  const shareCountRet = await request(
    "POST",
    H5_API_HOST + shareCountPath,
    buildSignedHeaders("POST", shareCountPath, token),
    {}
  );

  log("ShareCount HTTP = " + shareCountRet.resp.status);
  log("ShareCount body = " + String(shareCountRet.data || "").slice(0, 500));
  pushSummary.shareCountStatus = (Number(shareCountRet.resp.status) === 200 ? "✔ ShareCount 成功" : "❌ 失败 (HTTP " + shareCountRet.resp.status + ")");

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
    pushSummary.shareReporting = "✔ 上报成功 (HTTP 200)";
    return true;
  }

  notify("领克分享失败", "HTTP " + reportRet.resp.status, String(reportRet.data || "").slice(0, 200));
  pushSummary.shareReporting = "❌ 上报失败 (HTTP " + reportRet.resp.status + ")";
  return false;
}

/* =========================
 * Passive Capture
 * 这里只保留 /auth/login/refresh 的抓取。
 * ========================= */
function handleHttpRequest() {
  const url = $request.url || "";
  const headers = $request.headers || {};
  const query = parseUrlQuery(url);
  const deviceInfo = extractDeviceInfoFromUrlOrHeaders(url, headers);

  log("HTTP_REQUEST URL = " + url);
  log("SCRIPT_VERSION = " + SCRIPT_VERSION);

  const token = getHeader(headers, "token");
  const svcsid = getHeader(headers, "svcsid");

  const refreshToken =
    query.refreshToken ||
    query.refreshtoken ||
    getHeader(headers, "refreshToken") ||
    getHeader(headers, "refreshtoken") ||
    "";

  if (token) {
    write(token, STORE_TOKEN);
    log("token saved = " + mask(token, 12, 8));
  }

  if (svcsid) {
    write(svcsid, STORE_SVCSID);
    log("svcsid saved = " + mask(svcsid, 12, 8));
  }

  if (deviceInfo.deviceId) {
    write(deviceInfo.deviceId, STORE_DEVICE_ID);
    log("deviceId saved = " + mask(deviceInfo.deviceId, 8, 6));
  }

  if (deviceInfo.glDevId) {
    write(deviceInfo.glDevId, STORE_GL_DEV_ID);
    log("gl_dev_id saved = " + mask(deviceInfo.glDevId, 8, 6));
  }

  if (refreshToken) {
    write(refreshToken, STORE_REFRESH_TOKEN);
    log("refreshToken saved from request = " + mask(refreshToken, 12, 8));
  }

  if (token || svcsid || deviceInfo.deviceId || deviceInfo.glDevId || refreshToken) {
    notify("领克抓包成功", "refreshToken/deviceId 已更新", "后续可自动签到分享");
  }

  $done({});
}

function handleHttpResponse() {
  const url = ($request && $request.url) || "";
  const reqHeaders = ($request && $request.headers) || {};
  const body = ($response && $response.body) || "";
  const obj = parseJsonSafe(body);
  const query = parseUrlQuery(url);
  const deviceInfo = extractDeviceInfoFromUrlOrHeaders(url, reqHeaders);

  log("HTTP_RESPONSE URL = " + url);
  log("SCRIPT_VERSION = " + SCRIPT_VERSION);

  const refreshTokenFromUrl =
    query.refreshToken ||
    query.refreshtoken ||
    "";

  if (deviceInfo.deviceId) {
    write(deviceInfo.deviceId, STORE_DEVICE_ID);
    log("deviceId saved from response request = " + mask(deviceInfo.deviceId, 8, 6));
  }

  if (deviceInfo.glDevId) {
    write(deviceInfo.glDevId, STORE_GL_DEV_ID);
    log("gl_dev_id saved from response request = " + mask(deviceInfo.glDevId, 8, 6));
  }

  if (refreshTokenFromUrl) {
    write(refreshTokenFromUrl, STORE_REFRESH_TOKEN);
    log("refreshToken saved from response url = " + mask(refreshTokenFromUrl, 12, 8));
  }

  const refreshToken = extractRefreshTokenFromBody(obj);
  const accessToken = extractAccessTokenFromBody(obj);

  log("auth refresh response body = " + String(body || "").slice(0, 1200));

  if (refreshToken) {
    write(refreshToken, STORE_REFRESH_TOKEN);
    log("refreshToken saved from response body = " + mask(refreshToken, 12, 8));
  }

  if (accessToken) {
    write(accessToken, STORE_ACCESS_TOKEN);
    write(accessToken, STORE_TOKEN);
    write(accessToken, STORE_SVCSID);
    write(formatGmt8Day(Date.now()), STORE_ACCESS_TOKEN_DAY);
    log("accessToken saved from response body = " + mask(accessToken, 12, 8));
  }

  if (refreshTokenFromUrl || refreshToken || accessToken || deviceInfo.deviceId || deviceInfo.glDevId) {
    notify("领克登录信息已保存", "refreshToken/deviceId", "后续可自动签到分享");
  }

  $done({});
}

/* =========================
 * State Log
 * ========================= */
function logStoredState() {
  log("Plugin pushToken = " + mask(pushToken, 6, 4));
  log("Plugin pushTopic = " + (pushTopic || "empty"));
  log("Plugin notifyOnSuccess = " + notifyOnSuccess);
  log("Stored refreshToken = " + mask(read(STORE_REFRESH_TOKEN), 12, 8));
  log("Stored deviceId = " + mask(read(STORE_DEVICE_ID), 8, 6));
  log("Stored gl_dev_id = " + mask(read(STORE_GL_DEV_ID), 8, 6));
  log("Stored accessToken = " + mask(read(STORE_ACCESS_TOKEN), 12, 8));
  log("Stored token = " + mask(read(STORE_TOKEN), 12, 8));
  log("Stored svcsid = " + mask(read(STORE_SVCSID), 12, 8));
  log("Stored shareCode = " + mask(read(STORE_SHARE_CODE), 12, 8));
  log("Stored shareCode day = " + (read(STORE_SHARE_CODE_DAY) || "empty"));
  log("Stored shareCode source = " + (read(STORE_SHARE_CODE_SOURCE) || "empty"));
  log("Stored used ids = " + (read(STORE_USED_IDS) || "[]"));
}


/* =========================
 * PushPlus WeChat Notification
 * ========================= */
function sendPushPlus(title, html) {
  if (!pushToken) {
    log("PushPlus: 未配置 pushToken，跳过微信推送");
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const payload = {
      token: pushToken,
      title: title,
      content: html,
      template: "html",
      channel: "wechat"
    };

    if (pushTopic) {
      payload.topic = pushTopic;
    }

    log("PushPlus: 正在推送通知到 " + (pushTopic ? "群组[" + pushTopic + "]" : "个人账号") + "...");

    $httpClient.post(
      {
        url: pushUrl,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      },
      (err, resp, data) => {
        if (err) {
          log("PushPlus 推送异常: " + String(err));
          resolve();
          return;
        }

        let res = parseJsonSafe(data);
        if (Number(res.code) === 200) {
          log("PushPlus 推送成功 (流水号: " + (res.data || "") + ")");
        } else {
          log("PushPlus 推送失败: " + (res.msg || res.message || data));
        }
        resolve();
      }
    );
  });
}

function buildReportHtml() {
  const isAllOk = pushSummary.allSuccess && !pushSummary.errors.length && pushSummary.tokenStatus.indexOf("✔") !== -1 && pushSummary.signStatus.indexOf("✔") !== -1;
  const statusBadge = isAllOk
    ? '<span style="background:rgba(16,185,129,0.15);border:1px solid #10b981;color:#10b981;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;">✔ 全部正常</span>'
    : '<span style="background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#ef4444;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;">⚠️ 存在异常</span>';

  let taskHtml = "";
  if (pushSummary.taskList && pushSummary.taskList.length) {
    taskHtml = pushSummary.taskList.map(function(item) {
      return (
        '<div style="background:#121924;padding:8px 10px;border-radius:8px;margin-bottom:6px;">' +
        '  <div style="display:flex;justify-content:space-between;font-weight:600;">' +
        '    <span style="color:#e2e8f0;">' + item.name + '</span>' +
        '    <span style="color:#38bdf8;">' + item.process + '</span>' +
        '  </div>' +
        (item.reward ? '  <div style="font-size:11px;color:#94a3b8;margin-top:2px;">🎁 达成奖励：' + item.reward + '</div>' : '') +
        '</div>'
      );
    }).join("");
  } else {
    taskHtml = '<div style="font-size:12px;color:#94a3b8;padding:4px 0;">暂无任务列表数据</div>';
  }

  const articleTitleDisplay = pushSummary.articleTitle || "未知文章";

  return (
    '<div style="max-width:520px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f141c;color:#e1e7ec;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.3);border:1px solid #1f2937;">' +
    '  <div style="background:linear-gradient(135deg,#0f2027 0%,#203a43 50%,#2c5364 100%);padding:20px 18px 16px 18px;border-bottom:1px solid #2a3b4c;">' +
    '    <div style="display:flex;justify-content:space-between;align-items:center;">' +
    '      <div>' +
    '        <span style="font-size:11px;font-weight:700;color:#00d2ff;letter-spacing:1.5px;text-transform:uppercase;">LYNK & CO AUTOMATION</span>' +
    '        <h2 style="margin:4px 0 0 0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">lynkco分享诊断</h2>' +
    '      </div>' +
    '      <div>' + statusBadge + '</div>' +
    '    </div>' +
    '    <div style="margin-top:10px;font-size:12px;color:#94a3b8;">' +
    '      <span>📅 诊断时间：' + pushSummary.timeStr + '</span>' +
    '    </div>' +
    '  </div>' +
    '  <div style="padding:16px;">' +
    '    <div style="display:flex;gap:10px;margin-bottom:12px;">' +
    '      <div style="flex:1;background:#182230;padding:12px 14px;border-radius:12px;border:1px solid #26354a;text-align:center;">' +
    '        <div style="font-size:12px;color:#94a3b8;">🔥 连续签到</div>' +
    '        <div style="font-size:24px;font-weight:800;color:#00d2ff;margin-top:2px;">' + pushSummary.continueDays + ' <span style="font-size:13px;font-weight:normal;color:#94a3b8;">天</span></div>' +
    '      </div>' +
    '      <div style="flex:1;background:#182230;padding:12px 14px;border-radius:12px;border:1px solid #26354a;text-align:center;">' +
    '        <div style="font-size:12px;color:#94a3b8;">🎫 补签卡库存</div>' +
    '        <div style="font-size:24px;font-weight:800;color:#10b981;margin-top:2px;">' + pushSummary.signCardNumber + ' <span style="font-size:13px;font-weight:normal;color:#94a3b8;">张</span></div>' +
    '      </div>' +
    '    </div>' +
    '    <div style="background:#182230;border-radius:12px;padding:14px;margin-bottom:12px;border:1px solid #26354a;">' +
    '      <div style="font-size:13px;font-weight:700;color:#38bdf8;margin-bottom:10px;display:flex;align-items:center;">' +
    '        <span style="display:inline-block;width:4px;height:13px;background:#38bdf8;border-radius:2px;margin-right:6px;"></span>' +
    '        🔐 通道与签到诊断' +
    '      </div>' +
    '      <div style="font-size:13px;line-height:1.8;">' +
    '        <div style="display:flex;justify-content:space-between;border-bottom:1px dashed #243242;padding-bottom:4px;">' +
    '          <span style="color:#94a3b8;">Token 自动续期</span>' +
    '          <span style="color:#10b981;font-weight:600;">' + pushSummary.tokenStatus + '</span>' +
    '        </div>' +
    '        <div style="display:flex;justify-content:space-between;border-bottom:1px dashed #243242;padding:4px 0;">' +
    '          <span style="color:#94a3b8;">今日签到状态</span>' +
    '          <span style="color:#38bdf8;font-weight:600;">' + pushSummary.signStatus + ' (' + (pushSummary.signDetail || "无") + ')</span>' +
    '        </div>' +
    '        <div style="display:flex;justify-content:space-between;padding-top:4px;">' +
    '          <span style="color:#94a3b8;">专属分享码</span>' +
    '          <span style="color:#10b981;font-weight:600;">' + (pushSummary.shareCodeStatus || "✔ 已就绪") + '</span>' +
    '        </div>' +
    '      </div>' +
    '    </div>' +
    '    <div style="background:#182230;border-radius:12px;padding:14px;margin-bottom:12px;border:1px solid #26354a;">' +
    '      <div style="font-size:13px;font-weight:700;color:#a855f7;margin-bottom:10px;display:flex;align-items:center;">' +
    '        <span style="display:inline-block;width:4px;height:13px;background:#a855f7;border-radius:2px;margin-right:6px;"></span>' +
    '        📊 签到成长任务矩阵' +
    '      </div>' +
    '      <div style="font-size:12px;color:#cbd5e1;line-height:1.9;">' +
    taskHtml +
    '      </div>' +
    '    </div>' +
    '    <div style="background:#182230;border-radius:12px;padding:14px;margin-bottom:12px;border:1px solid #26354a;">' +
    '      <div style="font-size:13px;font-weight:700;color:#f59e0b;margin-bottom:10px;display:flex;align-items:center;">' +
    '        <span style="display:inline-block;width:4px;height:13px;background:#f59e0b;border-radius:2px;margin-right:6px;"></span>' +
    '        📰 探索文章自动分享链路' +
    '      </div>' +
    '      <div style="font-size:13px;line-height:1.8;">' +
    '        <div style="display:flex;justify-content:space-between;border-bottom:1px dashed #243242;padding-bottom:4px;">' +
    '          <span style="color:#94a3b8;">选中文章标题</span>' +
    '          <span style="color:#ffffff;font-weight:600;max-width:60%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + articleTitleDisplay + '</span>' +
    '        </div>' +
    '        <div style="display:flex;justify-content:space-between;border-bottom:1px dashed #243242;padding:4px 0;">' +
    '          <span style="color:#94a3b8;">文章阅读上报</span>' +
    '          <span style="color:#10b981;font-weight:600;">' + pushSummary.readCountStatus + '</span>' +
    '        </div>' +
    '        <div style="display:flex;justify-content:space-between;border-bottom:1px dashed #243242;padding:4px 0;">' +
    '          <span style="color:#94a3b8;">文章分享计数</span>' +
    '          <span style="color:#10b981;font-weight:600;">' + pushSummary.shareCountStatus + '</span>' +
    '        </div>' +
    '        <div style="display:flex;justify-content:space-between;padding-top:4px;">' +
    '          <span style="color:#94a3b8;">任务最终回执</span>' +
    '          <span style="color:#10b981;font-weight:700;">' + pushSummary.shareReporting + '</span>' +
    '        </div>' +
    '      </div>' +
    '    </div>' +
    '    <div style="text-align:center;padding-top:4px;font-size:11px;color:#64748b;">' +
    '      Loon Automation Service • ' + SCRIPT_VERSION +
    '    </div>' +
    '  </div>' +
    '</div>'
  );
}

/* =========================
 * Cron Main
 * ========================= */
async function runCron() {
  log("LynkCo sign + share start");
  log("SCRIPT_VERSION = " + SCRIPT_VERSION);
  logStoredState();

  try {
    pushSummary.timeStr = formatGmt8Time(Date.now());
    const accessToken = await refreshAccessTokenStrict();

    if (!accessToken) {
      pushSummary.tokenStatus = "❌ 刷新失败 (凭证缺失或过期)";
      notify(
        "领克任务失败",
        "refresh 失败",
        "缺少 refreshToken/deviceId 或 refreshToken 已过期，请重新登录抓包"
      );
      await sendPushPlus("lynkco分享诊断", buildReportHtml());
      $done({});
      return;
    }

    pushSummary.tokenStatus = "✔ 刷新成功";
    log("Business accessToken = " + mask(accessToken, 12, 8));

    await doDailySign(accessToken);
    await getSignInfo(accessToken);
    await getTaskList(accessToken);

    const shareCode = await fetchShareCodeDirect(accessToken);

    if (!shareCode) {
      pushSummary.shareReporting = "跳过 (未能获取shareCode)";
      notify("领克分享跳过", "shareCode 获取失败", "签到已尝试完成，请看日志");
      await sendPushPlus("lynkco分享诊断", buildReportHtml());
      $done({});
      return;
    }

    await doArticleShare(accessToken, shareCode);

    log("正在发送 PushPlus 汇总通知...");
    await sendPushPlus("lynkco分享诊断", buildReportHtml());

    log("LynkCo sign + share end");
    $done({});
  } catch (e) {
    log("Cron error = " + e);
    notify("领克脚本异常", "", String(e));
    await sendPushPlus("lynkco分享诊断", buildReportHtml());
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
