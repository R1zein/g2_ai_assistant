import { localNow } from '../../util/time.js';
import { type AssistantTool, toolSpec } from './types.js';

const USER_AGENT = 'g2-ai-assistant/0.1 (+https://github.com/r1zein/g2_ai_assistant)';

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const getLocation: AssistantTool = {
  spec: toolSpec(
    'get_current_location',
    'Return where the user is right now (coordinates plus a reverse-geocoded place name), ' +
      'as reported by the paired phone. Use it for "where am I", "how far is…", "what is nearby", ' +
      'and to decide whether the user can still make a booking on time.',
    {},
    [],
  ),
  async handler(_input, ctx) {
    if (!ctx.location) {
      return {
        summary: 'Location unavailable',
        content:
          'The app did not send a location. Either the user denied the location permission, ' +
          'or the phone had no fix. Answer without it and say so if it matters.',
        isError: true,
      };
    }

    const { latitude, longitude, accuracy } = ctx.location;
    let place: Record<string, unknown> | undefined;

    try {
      const data = (await fetchJson(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${latitude}&lon=${longitude}`,
        5_000,
      )) as { display_name?: string; address?: Record<string, string> };
      place = {
        displayName: data.display_name,
        city: data.address?.city ?? data.address?.town ?? data.address?.village,
        road: data.address?.road,
        country: data.address?.country,
      };
    } catch (err) {
      ctx.log.warn('reverse geocode failed', err);
    }

    return {
      summary: place?.city ? `Located near ${String(place.city)}` : 'Read current location',
      content: { latitude, longitude, accuracyMeters: accuracy, place },
    };
  },
};

const getWeather: AssistantTool = {
  spec: toolSpec(
    'get_weather',
    'Current conditions and a short forecast for a coordinate. Combine with get_current_location ' +
      'for "do I need a jacket", or with a booking\'s coordinates for "what is the weather at the hotel".',
    {
      latitude: { type: 'number' },
      longitude: { type: 'number' },
      days: { type: 'integer', description: 'Forecast days to include, 1-7.', minimum: 1, maximum: 7 },
    },
    ['latitude', 'longitude', 'days'],
  ),
  async handler(input, ctx) {
    const lat = Number(input.latitude);
    const lon = Number(input.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        summary: 'Weather lookup rejected',
        content: 'latitude and longitude must be numbers.',
        isError: true,
      };
    }

    const days = Math.min(7, Math.max(1, Number(input.days ?? 2)));
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      `&forecast_days=${days}&timezone=auto`;

    try {
      const data = await fetchJson(url, 6_000);
      return { summary: 'Read weather forecast', content: data };
    } catch (err) {
      ctx.log.warn('weather lookup failed', err);
      return {
        summary: 'Weather unavailable',
        content: `Weather service did not respond: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

const geocodePlace: AssistantTool = {
  spec: toolSpec(
    'geocode_place',
    'Turn a place name or address into coordinates, so it can be fed to get_weather or compared ' +
      'against the user\'s current position.',
    { query: { type: 'string', description: 'Place name or address, e.g. "Hotel Astoria, Prague".' } },
    ['query'],
  ),
  async handler(input, ctx) {
    const q = String(input.query ?? '').trim();
    if (!q) {
      return { summary: 'Geocode rejected', content: 'query must not be empty.', isError: true };
    }

    try {
      const data = (await fetchJson(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&q=${encodeURIComponent(q)}`,
        6_000,
      )) as Array<{ display_name: string; lat: string; lon: string; type: string }>;

      return {
        summary: `Geocoded "${q}" (${data.length} match${data.length === 1 ? '' : 'es'})`,
        content: {
          results: data.map((r) => ({
            displayName: r.display_name,
            latitude: Number(r.lat),
            longitude: Number(r.lon),
            kind: r.type,
          })),
        },
      };
    } catch (err) {
      ctx.log.warn('geocode failed', err);
      return {
        summary: 'Geocode unavailable',
        content: `Geocoding service did not respond: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

const getTime: AssistantTool = {
  spec: toolSpec(
    'get_current_time',
    'Current wall-clock time in a named timezone. Use it when the user asks about a destination ' +
      'timezone, or to reason about a flight that crosses zones.',
    {
      time_zone: {
        type: 'string',
        description: 'IANA timezone, e.g. Europe/Prague. Empty string means the user\'s own zone.',
      },
    },
    ['time_zone'],
  ),
  async handler(input, ctx) {
    const zone = String(input.time_zone ?? '').trim() || ctx.timeZone;
    try {
      return {
        summary: `Read the clock in ${zone}`,
        content: { timeZone: zone, localTime: localNow(zone), utc: new Date().toISOString() },
      };
    } catch {
      return {
        summary: 'Unknown timezone',
        content: `"${zone}" is not a valid IANA timezone identifier.`,
        isError: true,
      };
    }
  },
};

export const contextTools: AssistantTool[] = [getLocation, getWeather, geocodePlace, getTime];
