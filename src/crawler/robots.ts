interface RobotsRules {
  disallowedPaths: string[];
}

const robotsCache = new Map<string, RobotsRules>();

function parseRobotsTxt(text: string): RobotsRules {
  const disallowedPaths: string[] = [];
  let appliesToUs = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const lowerKey = key.trim().toLowerCase();

    if (lowerKey === "user-agent") {
      appliesToUs = value === "*" || value.toLowerCase() === "nexabot";
    } else if (lowerKey === "disallow" && appliesToUs && value) {
      disallowedPaths.push(value);
    }
  }

  return { disallowedPaths };
}

async function getRobotsRules(origin: string): Promise<RobotsRules> {
  if (robotsCache.has(origin)) {
    return robotsCache.get(origin)!;
  }

  let rules: RobotsRules = { disallowedPaths: [] };

  try {
    const res = await fetch(`${origin}/robots.txt`);
    if (res.ok) {
      const text = await res.text();
      rules = parseRobotsTxt(text);
    }
  } catch {
    // No robots.txt, or it failed to load — treat as "everything allowed".
  }

  robotsCache.set(origin, rules);
  return rules;
}

/** Checks whether NexaBot is allowed to fetch the given URL. */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const rules = await getRobotsRules(parsed.origin);

  return !rules.disallowedPaths.some((disallowed) =>
    parsed.pathname.startsWith(disallowed),
  );
}
