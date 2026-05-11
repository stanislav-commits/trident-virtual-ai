import type { AuthUser } from "../../types/auth";

export type AvatarUser = Pick<
  AuthUser,
  "email" | "firstName" | "displayName" | "name"
>;

function splitGraphemes(value: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });

    return Array.from(segmenter.segment(value), (segment) => segment.segment);
  }

  return Array.from(value);
}

function firstVisibleCharacter(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  const graphemes = splitGraphemes(trimmed);
  const letter = graphemes.find((item) => /\p{L}/u.test(item));

  return letter ?? graphemes.find((item) => item.trim()) ?? null;
}

export function getUserAvatarInitial(user: AvatarUser | null | undefined): string {
  const source =
    user?.firstName?.trim() ||
    user?.displayName?.trim() ||
    user?.name?.trim() ||
    user?.email?.trim();

  return firstVisibleCharacter(source)?.toLocaleUpperCase() ?? "U";
}

export function getUserAvatarLabel(user: AvatarUser | null | undefined): string {
  return (
    user?.firstName?.trim() ||
    user?.displayName?.trim() ||
    user?.name?.trim() ||
    user?.email?.trim() ||
    "User profile"
  );
}
