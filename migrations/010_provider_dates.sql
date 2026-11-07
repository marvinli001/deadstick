ALTER TABLE providers
  ADD COLUMN opened_on date,
  ADD COLUMN closed_on date,
  ADD CONSTRAINT provider_dates_order CHECK (closed_on >= opened_on);
