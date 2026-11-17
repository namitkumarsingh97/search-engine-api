import { DriveItem, DriveItemDocument } from "../database/models/DriveItem";
import { searchIndex } from "../search/indexer";

/** Adds/updates a Drive item in the search index, or removes it if trashed. */
export function indexDriveItem(item: DriveItemDocument): void {
  const id = String(item._id);

  if (item.trashedAt) {
    searchIndex.removeDocument(id);
    return;
  }

  searchIndex.addDocument({
    id,
    type: "file",
    ownerId: item.ownerId,
    title: item.name,
    url: `/drive?open=${id}`,
    content: item.content || (item.kind === "folder" ? "Folder" : item.mimeType || "File"),
    headings: "",
    date: item.updatedAt?.toISOString(),
  });
}

export function unindexDriveItem(id: string): void {
  searchIndex.removeDocument(id);
}

/** Called once on boot, alongside the web page index load. */
export async function loadDriveIntoIndex(): Promise<number> {
  const items = await DriveItem.find({ trashedAt: null });
  items.forEach(indexDriveItem);
  return items.length;
}
