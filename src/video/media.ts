import { spawn } from "child_process";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

export interface MediaInfo {
  duration?: number;
  thumbnailCreated: boolean;
}

/**
 * Grabs a thumbnail and reads the duration with ffmpeg. Entirely optional:
 * if ffmpeg isn't installed (or fails) the video still works, it just has no
 * thumbnail/duration. Never throws.
 */
export function probeAndThumbnail(inputPath: string, thumbnailPath: string): Promise<MediaInfo> {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (info: MediaInfo) => {
      if (!settled) {
        settled = true;
        resolve(info);
      }
    };

    // -ss before -i seeks fast; 1s in avoids black first frames on most clips.
    const proc = spawn(
      FFMPEG,
      ["-y", "-ss", "1", "-i", inputPath, "-frames:v", "1", "-vf", "scale=480:-2", thumbnailPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    const timer = setTimeout(() => proc.kill(), 30_000);
    proc.stderr.on("data", (d) => {
      if (stderr.length < 20_000) stderr += d.toString();
    });
    proc.on("error", () => {
      clearTimeout(timer);
      done({ thumbnailCreated: false }); // ffmpeg not installed
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
      done({ duration, thumbnailCreated: code === 0 });
    });
  });
}
