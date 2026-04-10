if [[ -n "${USER_ZDOTDIR:-}" && "$USER_ZDOTDIR" != "$ZDOTDIR" && -f "$USER_ZDOTDIR/.zprofile" ]]; then
  . "$USER_ZDOTDIR/.zprofile"
fi
