if [[ -n "${USER_ZDOTDIR:-}" && "$USER_ZDOTDIR" != "$ZDOTDIR" && -f "$USER_ZDOTDIR/.zshrc" ]]; then
  . "$USER_ZDOTDIR/.zshrc"
fi

# CodeDeck runs zsh sessions that can land in vi insert mode, where ^R only
# redraws the prompt. Restore reverse history search without changing the rest
# of the user's keymap.
bindkey -M viins '^R' history-incremental-search-backward
