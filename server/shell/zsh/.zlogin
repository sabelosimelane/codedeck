if [[ -n "${USER_ZDOTDIR:-}" && "$USER_ZDOTDIR" != "$ZDOTDIR" && -f "$USER_ZDOTDIR/.zlogin" ]]; then
  . "$USER_ZDOTDIR/.zlogin"
fi
