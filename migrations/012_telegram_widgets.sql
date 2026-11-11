CREATE TABLE telegram_widgets (
  id text PRIMARY KEY,
  chat_id text NOT NULL,
  message_id bigint,
  revision text NOT NULL,
  document jsonb NOT NULL,
  subject text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_widgets_message ON telegram_widgets(chat_id,message_id);
CREATE INDEX telegram_widgets_subject ON telegram_widgets(subject) WHERE subject IS NOT NULL;
