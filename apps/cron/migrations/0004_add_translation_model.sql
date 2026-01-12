-- Track which AI model was used for each translation
ALTER TABLE `translations` ADD COLUMN `model` TEXT;
