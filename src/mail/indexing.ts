import { MailItem, MailItemDocument } from "../database/models/MailItem";
import { Message, MessageDocument } from "../database/models/Message";
import { searchIndex } from "../search/indexer";

/**
 * Mail is private per user: every MailItem is indexed under its own id with the
 * owner's id, so you only ever find your own copy. Trashed mail is not searchable.
 */
export function indexMailItem(item: MailItemDocument, message: MessageDocument): void {
  const id = String(item._id);
  if (item.folder === "trash") {
    searchIndex.removeDocument(id);
    return;
  }

  const people = [message.from, ...message.to, ...message.cc].map((a) => `${a.name} ${a.email}`).join(" ");
  const attachmentNames = message.attachments.map((a) => a.name).join(" ");

  searchIndex.addDocument({
    id,
    type: "mail",
    ownerId: item.userId,
    title: message.subject || "(no subject)",
    url: `/mail?folder=${item.folder}&item=${id}`,
    content: [people, message.body, attachmentNames].filter(Boolean).join(" — ").slice(0, 60_000),
    headings: "",
    date: item.date?.toISOString(),
  });
}

export function unindexMailItem(id: string): void {
  searchIndex.removeDocument(id);
}

export async function loadMailIntoIndex(): Promise<number> {
  const items = await MailItem.find({ folder: { $ne: "trash" } });
  const messages = await Message.find({ _id: { $in: [...new Set(items.map((i) => String(i.messageId)))] } });
  const byId = new Map(messages.map((m) => [String(m._id), m]));

  let count = 0;
  for (const item of items) {
    const message = byId.get(String(item.messageId));
    if (!message) continue;
    indexMailItem(item, message);
    count++;
  }
  return count;
}
