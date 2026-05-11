import {
  getUserAvatarInitial,
  getUserAvatarLabel,
  type AvatarUser,
} from "./userAvatarUtils";

interface UserAvatarProps {
  user: AvatarUser | null | undefined;
  className?: string;
  ariaLabel?: string;
  title?: string;
}

export function UserAvatar({
  user,
  className,
  ariaLabel,
  title,
}: UserAvatarProps) {
  const label = getUserAvatarLabel(user);
  const classNames = ["user-avatar", className].filter(Boolean).join(" ");

  return (
    <span
      className={classNames}
      role="img"
      aria-label={ariaLabel ?? label}
      title={title ?? label}
    >
      <span className="user-avatar__initial">{getUserAvatarInitial(user)}</span>
    </span>
  );
}
