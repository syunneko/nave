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

type Preference = "shortest" | "cheapest";
type LatLng = [number, number];

interface RouteLeg {
  mode: "train" | "bus" | "walk";
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

function getMockTransitCandidates(
  origin: string,
  destination: string,
  originCoords?: LatLng
): RouteCandidate[] {
  const hakata: LatLng = originCoords ?? [33.5897, 130.4207];
  const gion: LatLng = [33.5941, 130.4139];
  const nakasu: LatLng = [33.5949, 130.4055];
  const tenjin: LatLng = [33.5914, 130.3989];

  const hakataBusStop: LatLng = originCoords ?? [33.5902, 130.4195];
  const canalCityStop: LatLng = [33.5898, 130.4109];
  const tenjinBusStop: LatLng = [33.5906, 130.4004];
  const tenjinGoal: LatLng = [33.5918, 130.3984];

  const yoshizuka: LatLng = [33.6064, 130.4241];
  const maidashi: LatLng = [33.6088, 130.4184];

  const gpsNotePrefix = originCoords ? "現在地（GPS）付近から" : "";

  return [
    {
      routeId: "A",
      summary: "地下鉄 空港線（直通）",
      durationMinutes: 6,
      fareYen: 260,
      transfers: 0,
      color: "#0284c7",
      legs: [
        {
          mode: "train",
          lineName: "福岡市地下鉄 空港線（姪浜方面）",
          boardAt: `${origin} 近くの地下鉄駅・のりば`,
          alightAt: `${destination} 地下鉄ホーム`,
          boardCoords: hakata,
          alightCoords: tenjin,
          path: [hakata, gion, nakasu, tenjin],
          durationMinutes: 6,
          note: `${gpsNotePrefix}乗り換えなしの最速直通ルート`,
        },
      ],
    },
    {
      routeId: "B",
      summary: "西鉄路線バス（都心循環）",
      durationMinutes: 18,
      fareYen: 190,
      transfers: 0,
      color: "#059669",
      legs: [
        {
          mode: "bus",
          lineName: "西鉄バス（国体道路・キャナルシティ経由）",
          boardAt: `${origin} 近くのバス停`,
          alightAt: `${destination}前 バス停`,
          boardCoords: hakataBusStop,
          alightCoords: tenjinBusStop,
          path: [hakataBusStop, canalCityStop, tenjinBusStop],
          durationMinutes: 15,
          note: "運賃が最も安いお得ルート",
        },
        {
          mode: "walk",
          lineName: "徒歩移動",
          boardAt: `${destination}前 バス停`,
          alightAt: `${destination} 目的地入口`,
          boardCoords: tenjinBusStop,
          alightCoords: tenjinGoal,
          path: [tenjinBusStop, tenjinGoal],
          durationMinutes: 3,
        },
      ],
    },
    {
      routeId: "C",
      summary: "JR鹿児島本線 + 地下鉄 乗継",
      durationMinutes: 15,
      fareYen: 390,
      transfers: 1,
      color: "#7c3aed",
      legs: [
        {
          mode: "train",
          lineName: "JR鹿児島本線（普通）",
          boardAt: `${origin} 近くのJR駅ホーム`,
          alightAt: "吉塚駅",
          boardCoords: hakata,
          alightCoords: yoshizuka,
          path: [hakata, yoshizuka],
          durationMinutes: 4,
        },
        {
          mode: "walk",
          lineName: "連絡通路・乗り換え",
          boardAt: "JR吉塚駅 改札口",
          alightAt: "馬出九大病院前駅 改札口",
          boardCoords: yoshizuka,
          alightCoords: maidashi,
          path: [yoshizuka, maidashi],
          durationMinutes: 4,
          note: "案内表示に沿って地下鉄駅へ移動",
        },
        {
          mode: "train",
          lineName: "地下鉄 箱崎線・空港線",
          boardAt: "馬出九大病院前駅 ホーム",
          alightAt: `${destination} 地下鉄ホーム`,
          boardCoords: maidashi,
          alightCoords: tenjin,
          path: [maidashi, nakasu, tenjin],
          durationMinutes: 7,
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
    const { origin, destination, preference, userNote, apiKey, originCoords } =
      req.body as {
        origin: string;
        destination: string;
        preference: Preference;
        userNote?: string;
        apiKey?: string;
        originCoords?: LatLng;
      };

    const effectiveApiKey = (apiKey || process.env.GEMINI_API_KEY || "").trim();
    const candidates = getMockTransitCandidates(
      origin,
      destination,
      originCoords
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
        `出発:${origin} / 到着:${destination} / 優先:${prefLabel} / 要望:${userNote || "なし"} / 最適ID:${bestRoute.routeId}`,
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動完了: http://localhost:${PORT}`);
});