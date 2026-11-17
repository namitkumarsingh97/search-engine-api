import { Video, VideoDocument } from "../database/models/Video";
import { searchIndex } from "../search/indexer";

/**
 * Public videos are indexed without an owner (visible to everyone, like web
 * pages); private ones carry ownerId so only their owner can find them.
 */
export function indexVideo(video: VideoDocument): void {
  const id = String(video._id);
  searchIndex.addDocument({
    id,
    type: "video",
    ownerId: video.visibility === "private" ? video.ownerId : undefined,
    title: video.title,
    url: `/watch/${id}`,
    content: [video.description, `by ${video.ownerName}`].filter(Boolean).join(" — "),
    headings: "",
    date: video.createdAt?.toISOString(),
  });
}

export function unindexVideo(id: string): void {
  searchIndex.removeDocument(id);
}

export async function loadVideosIntoIndex(): Promise<number> {
  const videos = await Video.find();
  videos.forEach(indexVideo);
  return videos.length;
}
