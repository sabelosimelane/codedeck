if [[ -n "${USER_ZDOTDIR:-}" && "$USER_ZDOTDIR" != "$ZDOTDIR" && -f "$USER_ZDOTDIR/.zshenv" ]]; then
  . "$USER_ZDOTDIR/.zshenv"
fi
