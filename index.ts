import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

type Preference = "shortest" | "cheapest";
type LatLng = [number, number];
type TransportMode = "train" | "bus" | "walk" | "flight";

interface RouteLeg {
  mode: TransportMode;
  lineName: string;
  boardAt: string;
  alightAt: string;
  boardCoords: LatLng;
  alightCoords: LatLng;
  path: LatLng[];
  durationMinutes: number;
  note?: string;
}

interface RouteCandidate {
  routeId: string;
  summary: string;
  durationMinutes: number;
  fareYen: number;
  transfers: number;
  color: string;
  legs: RouteLeg[];
}

const KNOWN_PLACES: Record<string, LatLng> = {
  博多駅: [33.5897, 130.4207],
  博多: [33.5897, 130.4207],
  天神駅: [33.5914, 130.3989],
  天神: [33.5914, 130.3989],
  祇園駅: [33.5941, 130.4139],
  中洲川端駅: [33.5949, 130.4055],
  吉塚駅: [33.6064, 130.4241],
  福岡空港駅: [33.5955, 130.4446],
  福岡空港: [33.5955, 130.4446],
  大橋駅: [33.5604, 130.4328],
  西新駅: [33.5818, 130.3583],
  小倉駅: [33.8868, 130.8825],
  熊本駅: [32.7898, 130.6894],
  長崎駅: [32.7626, 130.8705],
  鹿児島中央駅: [31.5838, 130.5418],
  広島駅: [34.3977, 132.4754],
  岡山駅: [34.6662, 133.9182],
  大阪駅: [34.7024, 135.4959],
  梅田駅: [34.7055, 135.4983],
  新大阪駅: [34.7334, 135.5003],
  関西空港: [34.432, 135.2304],
  伊丹空港: [34.7855, 135.4382],
  なんば駅: [34.6629, 135.5013],
  京都駅: [34.9858, 135.7588],
  神戸三宮駅: [34.6946, 135.1955],
  名古屋駅: [35.1709, 136.8816],
  中部国際空港: [34.8584, 136.8054],
  東京駅: [35.6812, 139.7671],
  羽田空港: [35.5494, 139.7798],
  成田空港: [35.7719, 140.3929],
  新宿駅: [35.6896, 139.7006],
  渋谷駅: [35.658, 139.7016],
  横浜駅: [35.4658, 139.6223],
  仙台駅: [38.2601, 140.8817],
  新千歳空港: [42.7752, 141.6924],
  札幌駅: [43.0687, 141.3508],
  那覇空港: [26.2064, 127.6465],
};

function hashText(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolvePlaceCoords(place: string, fallbackCoords?: LatLng): LatLng {
  if (fallbackCoords) {
    return fallbackCoords;
  }

  const normalized = place.trim();
  if (!normalized) {
    return [33.5914, 130.3989];
  }

  if (KNOWN_PLACES[normalized]) {
    return KNOWN_PLACES[normalized];
  }

  for (const [key, coords] of Object.entries(KNOWN_PLACES)) {
    if (key.length >= 2 && normalized.startsWith(key)) {
      return coords;
    }
  }

  const h = hashText(normalized);
  const latOffset = (((h % 1000) / 1000) - 0.35) * 8.0;
  const lngOffset = ((((Math.floor(h / 1000)) % 1000) / 1000) - 0.3) * 9.0;
  return [
    Number((33.59 + latOffset).toFixed(5)),
    Number((130.42 + lngOffset).toFixed(5)),
  ];
}

function interpolatePoint(
  a: LatLng,
  b: LatLng,
  ratio: number,
  jitterLat = 0,
  jitterLng = 0
): LatLng {
  return [
    Number((a[0] + (b[0] - a[0]) * ratio + jitterLat).toFixed(5)),
    Number((a[1] + (b[1] - a[1]) * ratio + jitterLng).toFixed(5)),
  ];
}

function calculateDistanceKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * sinLng * sinLng;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function buildDynamicTransitCandidates(
  origin: string,
  destination: string,
  originCoords?: LatLng,
  includeFlight = true
): RouteCandidate[] {
  const cleanOrigin = origin.trim() || "出発地";
  const cleanDest = destination.trim() || "目的地";

  const startCoord = resolvePlaceCoords(cleanOrigin, originCoords);
  const endCoord = resolvePlaceCoords(cleanDest);

  const distKm = Math.max(0.8, calculateDistanceKm(startCoord, endCoord));
  const isLongDistance = distKm >= 20;
  const seed = hashText(`${cleanOrigin}->${cleanDest}`);

  const mid1 = interpolatePoint(startCoord, endCoord, 0.33, 0.015, -0.015);
  const mid2 = interpolatePoint(startCoord, endCoord, 0.67, -0.015, 0.015);
  const busMid = interpolatePoint(startCoord, endCoord, 0.5, -0.025, 0.02);
  const busStopNearDest = interpolatePoint(startCoord, endCoord, 0.92, -0.005, 0.005);
  const hub1 = interpolatePoint(startCoord, endCoord, 0.42, 0.02, 0.02);
  const hub2 = interpolatePoint(startCoord, endCoord, 0.48, 0.025, 0.025);

  const gpsPrefix = originCoords ? "GPS現在地周辺から" : "";

  if (isLongDistance) {
    const shinkansenMin = Math.max(35, Math.round(distKm * 0.32) + (seed % 10));
    const highwayBusMin = Math.max(shinkansenMin + 45, Math.round(distKm * 0.78) + 15);
    const localComboMin = Math.max(shinkansenMin + 25, Math.round(distKm * 0.55) + 10);

    const shinkansenFare = Math.max(1200, Math.round((900 + distKm * 16) / 100) * 100);
    const highwayBusFare = Math.max(900, Math.round((shinkansenFare * 0.55) / 100) * 100);
    const localComboFare = Math.max(1000, Math.round((shinkansenFare * 0.78) / 100) * 100);

    const candidates: RouteCandidate[] = [];

    if (includeFlight) {
      const flightAirMin = Math.max(45, Math.min(180, Math.round(distKm * 0.11) + 40));
      const accessMin = 20;
      const totalFlightMin = flightAirMin + accessMin * 2;
      const flightFare = Math.max(7800, Math.round((7500 + distKm * 14) / 500) * 500);

      candidates.push({
        routeId: "A",
        summary: `${cleanOrigin} → ${cleanDest} 飛行機ルート`,
        durationMinutes: totalFlightMin,
        fareYen: flightFare,
        transfers: 2,
        color: "#0284c7",
        legs: [
          {
            mode: "train",
            lineName: `出発地 → 出発空港 アクセス線`,
            boardAt: `${cleanOrigin} 最寄り駅・のりば`,
            alightAt: `出発空港 ターミナル`,
            boardCoords: startCoord,
            alightCoords: mid1,
            path: [startCoord, mid1],
            durationMinutes: accessMin,
            note: `${gpsPrefix}保安検査（出発20〜30分前目安）に余裕を持って移動`,
          },
          {
            mode: "flight",
            lineName: `国内線・航空便（${cleanDest}方面空港行き）`,
            boardAt: `出発空港 搭乗口`,
            alightAt: `到着空港 到着ロビー`,
            boardCoords: mid1,
            alightCoords: mid2,
            path: [mid1, mid2],
            durationMinutes: flightAirMin,
            note: "フライト時間（搭乗・手荷物受取を含めた目安）",
          },
          {
            mode: "train",
            lineName: `到着空港 → ${cleanDest} アクセス連絡`,
            boardAt: `到着空港 駅・バスのりば`,
            alightAt: `${cleanDest} 到着地点`,
            boardCoords: mid2,
            alightCoords: endCoord,
            path: [mid2, endCoord],
            durationMinutes: accessMin,
          },
        ],
      });
    }

    candidates.push({
      routeId: includeFlight ? "B" : "A",
      summary: `${cleanOrigin} → ${cleanDest} 新幹線・特急ルート`,
      durationMinutes: shinkansenMin,
      fareYen: shinkansenFare,
      transfers: 1,
      color: "#2563eb",
      legs: [
        {
          mode: "train",
          lineName: `${cleanOrigin}発 アクセス線`,
          boardAt: `${cleanOrigin} 最寄り駅・ホーム`,
          alightAt: `${cleanOrigin} 幹線ターミナル駅`,
          boardCoords: startCoord,
          alightCoords: mid1,
          path: [startCoord, mid1],
          durationMinutes: 12,
        },
        {
          mode: "train",
          lineName: `新幹線・特急（${cleanDest}方面）`,
          boardAt: `${cleanOrigin} 幹線ターミナル駅 ホーム`,
          alightAt: `${cleanDest} 到着駅 ホーム`,
          boardCoords: mid1,
          alightCoords: endCoord,
          path: [mid1, mid2, endCoord],
          durationMinutes: Math.max(20, shinkansenMin - 12),
          note: `${gpsPrefix}${cleanDest}方面へ速達で向かう鉄道ルート`,
        },
      ],
    });

    candidates.push({
      routeId: includeFlight ? "C" : "B",
      summary: `${cleanOrigin} → ${cleanDest} 高速バスルート`,
      durationMinutes: highwayBusMin,
      fareYen: highwayBusFare,
      transfers: 0,
      color: "#059669",
      legs: [
        {
          mode: "bus",
          lineName: `${cleanOrigin}〜${cleanDest} 高速路線バス`,
          boardAt: `${cleanOrigin} 高速バスのりば`,
          alightAt: `${cleanDest} バスターミナル`,
          boardCoords: startCoord,
          alightCoords: busStopNearDest,
          path: [startCoord, busMid, busStopNearDest],
          durationMinutes: Math.max(20, highwayBusMin - 5),
          note: "運賃を抑えやすく乗り換えなしで移動できるルート",
        },
        {
          mode: "walk",
          lineName: "徒歩移動",
          boardAt: `${cleanDest} バスターミナル`,
          alightAt: `${cleanDest} 到着地点`,
          boardCoords: busStopNearDest,
          alightCoords: endCoord,
          path: [busStopNearDest, endCoord],
          durationMinutes: 5,
        },
      ],
    });

    if (!includeFlight) {
      candidates.push({
        routeId: "C",
        summary: `${cleanOrigin} → ${cleanDest} 在来線・急行乗継ルート`,
        durationMinutes: localComboMin,
        fareYen: localComboFare,
        transfers: 2,
        color: "#7c3aed",
        legs: [
          {
            mode: "train",
            lineName: `${cleanOrigin}発 広域幹線`,
            boardAt: `${cleanOrigin} 乗車ホーム`,
            alightAt: `中間ジャンクション駅`,
            boardCoords: startCoord,
            alightCoords: hub1,
            path: [startCoord, hub1],
            durationMinutes: Math.max(15, Math.floor(localComboMin * 0.45)),
          },
          {
            mode: "walk",
            lineName: "駅構内乗り換え",
            boardAt: `中間ジャンクション駅 降車ホーム`,
            alightAt: `連絡線 乗車ホーム`,
            boardCoords: hub1,
            alightCoords: hub2,
            path: [hub1, hub2],
            durationMinutes: 7,
          },
          {
            mode: "train",
            lineName: `${cleanDest}行き 連絡線`,
            boardAt: `連絡線 ホーム`,
            alightAt: `${cleanDest} 降車ホーム`,
            boardCoords: hub2,
            alightCoords: endCoord,
            path: [hub2, endCoord],
            durationMinutes: Math.max(15, Math.ceil(localComboMin * 0.45)),
          },
        ],
      });
    }

    return candidates;
  }

  const fastMin = Math.max(4, Math.round(distKm * 3.2) + (seed % 3));
  const busMin = Math.max(fastMin + 4, Math.round(distKm * 4.5) + 3);
  const transferMin = Math.max(fastMin + 3, Math.round(distKm * 4.0) + 2);

  const fastFare = Math.max(180, Math.round((160 + distKm * 45) / 10) * 10);
  const busFare = Math.max(150, fastFare - 40);
  const transferFare = fastFare + 90;

  return [
    {
      routeId: "A",
      summary: `${cleanOrigin} → ${cleanDest} 鉄道・地下鉄ルート`,
      durationMinutes: fastMin,
      fareYen: fastFare,
      transfers: 0,
      color: "#0284c7",
      legs: [
        {
          mode: "train",
          lineName: `${cleanDest}方面 都市鉄道線`,
          boardAt: `${cleanOrigin} 最寄り駅・ホーム`,
          alightAt: `${cleanDest} 最寄り駅・ホーム`,
          boardCoords: startCoord,
          alightCoords: endCoord,
          path: [startCoord, mid1, mid2, endCoord],
          durationMinutes: fastMin,
          note: `${gpsPrefix}${cleanDest}へ乗り換えなしで向かう最短ルート`,
        },
      ],
    },
    {
      routeId: "B",
      summary: `${cleanOrigin} → ${cleanDest} 路線バス＋徒歩ルート`,
      durationMinutes: busMin,
      fareYen: busFare,
      transfers: 0,
      color: "#059669",
      legs: [
        {
          mode: "bus",
          lineName: `${cleanOrigin}〜${cleanDest} 幹線路線バス`,
          boardAt: `${cleanOrigin} バス停`,
          alightAt: `${cleanDest}前 バス停`,
          boardCoords: startCoord,
          alightCoords: busStopNearDest,
          path: [startCoord, busMid, busStopNearDest],
          durationMinutes: Math.max(3, busMin - 3),
          note: `${cleanDest}付近まで運賃を抑えられるバス中心ルート`,
        },
        {
          mode: "walk",
          lineName: "徒歩移動",
          boardAt: `${cleanDest}前 バス停`,
          alightAt: `${cleanDest} 到着地点`,
          boardCoords: busStopNearDest,
          alightCoords: endCoord,
          path: [busStopNearDest, endCoord],
          durationMinutes: 3,
        },
      ],
    },
    {
      routeId: "C",
      summary: `${cleanOrigin} → ${cleanDest} 1回乗継ルート`,
      durationMinutes: transferMin,
      fareYen: transferFare,
      transfers: 1,
      color: "#7c3aed",
      legs: [
        {
          mode: "train",
          lineName: `${cleanOrigin}発 連絡線`,
          boardAt: `${cleanOrigin} 乗車ホーム`,
          alightAt: `${cleanOrigin}〜${cleanDest} 中間乗換駅`,
          boardCoords: startCoord,
          alightCoords: hub1,
          path: [startCoord, hub1],
          durationMinutes: Math.max(2, Math.floor(transferMin / 2) - 1),
        },
        {
          mode: "walk",
          lineName: "乗り換え連絡通路",
          boardAt: `中間乗換駅 降車口`,
          alightAt: `乗継路線 乗車口`,
          boardCoords: hub1,
          alightCoords: hub2,
          path: [hub1, hub2],
          durationMinutes: 3,
          note: "案内サインに沿って次の路線へ移動",
        },
        {
          mode: "train",
          lineName: `${cleanDest}方面 接続線`,
          boardAt: `乗継路線 ホーム`,
          alightAt: `${cleanDest} 降車ホーム`,
          boardCoords: hub2,
          alightCoords: endCoord,
          path: [hub2, endCoord],
          durationMinutes: Math.max(2, Math.ceil(transferMin / 2) - 1),
        },
      ],
    },
  ];
}

function isRetryable503Error(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("503") || message.includes("UNAVAILABLE");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`AI応答がタイムアウト（${timeoutMs}ms）しました`));
    }, timeoutMs);

    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function generateFast(
  ai: GoogleGenAI,
  prompt: string,
  maxRetries = 1,
  timeoutMs = 5000
) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(
        ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: prompt,
          config: {
            maxOutputTokens: 450,
            temperature: 0.2,
          },
        }),
        timeoutMs
      );
    } catch (err: unknown) {
      lastError = err;
      if (!isRetryable503Error(err) || attempt === maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  throw lastError;
}

function buildFallbackExplanation(
  bestRoute: RouteCandidate,
  preference: Preference
): string {
  const reason =
    preference === "shortest"
      ? `所要時間が最も短い（**${bestRoute.durationMinutes}分**）ため`
      : `運賃が最も安い（**¥${bestRoute.fareYen}**）ため`;

  const boardingSteps = bestRoute.legs
    .map(
      (leg, idx) =>
        `${idx + 1}. **${leg.lineName}**: 「${leg.boardAt}」で乗車 → 「${leg.alightAt}」で下車（${leg.durationMinutes}分）`
    )
    .join("\n");

  return [
    `⚡ **高速モード（自動判定）で即時表示しています。**`,
    ``,
    `- **おすすめ:** ルート${bestRoute.routeId}（${bestRoute.summary} / **${bestRoute.durationMinutes}分** / **¥${bestRoute.fareYen}**・乗換${bestRoute.transfers}回）`,
    `- **理由:** ${reason}。`,
    ``,
    `**【乗降ガイド】**`,
    boardingSteps,
  ].join("\n");
}

app.post("/api/search", async (req, res) => {
  try {
    const {
      origin,
      destination,
      preference,
      userNote,
      apiKey,
      originCoords,
      includeFlight,
    } = req.body as {
      origin: string;
      destination: string;
      preference: Preference;
      userNote?: string;
      apiKey?: string;
      originCoords?: LatLng;
      includeFlight?: boolean;
    };

    const effectiveApiKey = (apiKey || process.env.GEMINI_API_KEY || "").trim();
    const useFlight = includeFlight !== false;
    const candidates = buildDynamicTransitCandidates(
      origin,
      destination,
      originCoords,
      useFlight
    );

    const sorted = [...candidates].sort((a, b) =>
      preference === "shortest"
        ? a.durationMinutes - b.durationMinutes
        : a.fareYen - b.fareYen
    );

    const bestRoute = sorted[0];
    if (!bestRoute) {
      res
        .status(404)
        .json({ error: "条件に合うルート候補が見つかりませんでした。" });
      return;
    }

    let aiExplanation = buildFallbackExplanation(bestRoute, preference);

    if (effectiveApiKey) {
      const prefLabel =
        preference === "shortest" ? "最短時間" : "最安運賃";

      const compactCandidates = candidates.map((c) => ({
        id: c.routeId,
        summary: c.summary,
        min: c.durationMinutes,
        yen: c.fareYen,
        transfers: c.transfers,
        legs: c.legs.map((l) => `${l.lineName}: ${l.boardAt} → ${l.alightAt}`),
      }));

      const prompt = [
        `出発:${origin} / 到着:${destination} / 優先:${prefLabel} / 飛行機:${useFlight ? "利用可" : "除外"} / 要望:${userNote || "なし"} / 最適ID:${bestRoute.routeId}`,
        `候補:${JSON.stringify(compactCandidates)}`,
        `150〜250字の日本語Markdownで簡潔に案内してください。`,
        `1) おすすめルートと理由 2) 乗車場所・路線・降車場所 3) 他ルートとの一言比較。`,
      ].join("\n");

      try {
        const ai = new GoogleGenAI({ apiKey: effectiveApiKey });
        const response = await generateFast(ai, prompt, 1, 5000);
        if (response.text && response.text.trim()) {
          aiExplanation = response.text.trim();
        }
      } catch (aiErr: unknown) {
        console.warn("AI高速フォールバック:", aiErr);
      }
    }

    res.json({
      bestRouteId: bestRoute.routeId,
      candidates,
      aiExplanation,
    });
  } catch (err: unknown) {
    console.error("Server Error:", err);
    const message =
      err instanceof Error ? err.message : "サーバー側でエラーが発生しました。";
    res.status(500).json({ error: message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`サーバー起動完了: http://0.0.0.0:${PORT}`);
});