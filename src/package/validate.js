const fs = require('fs');
const path = require('path');
const { articlePackageSchema } = require('./schema');

function validateArticlePackage(article, opts = {}) {
  const errors = [];
  const warnings = [];

  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    return { ok: false, errors: ['Article package must be a JSON object'], warnings };
  }

  for (const [field, rule] of Object.entries(articlePackageSchema)) {
    const value = article[field];
    if (rule.required && isBlank(value)) {
      errors.push(`${field} is required`);
      continue;
    }
    if (isBlank(value)) continue;
    if (rule.type === 'array') {
      if (!Array.isArray(value)) errors.push(`${field} must be an array`);
      continue;
    }
    if (typeof value !== rule.type) {
      errors.push(`${field} must be a ${rule.type}`);
      continue;
    }
    if (rule.minLength && value.trim().length < rule.minLength) errors.push(`${field} cannot be empty`);
    if (rule.maxLength && value.length > rule.maxLength) errors.push(`${field} exceeds max length ${rule.maxLength}`);
  }

  if (!article.coverPath && !article.coverMediaId && !article.cover_media_id && !article.thumb_media_id) {
    warnings.push('coverPath or coverMediaId is recommended before creating a WeChat draft');
  }

  if (opts.checkFiles) validateReferencedFiles(article, opts.baseDir || process.cwd(), errors, warnings);

  return { ok: errors.length === 0, errors, warnings };
}

function validateReferencedFiles(article, baseDir, errors, warnings) {
  if (article.coverPath !== undefined && article.coverPath !== '') {
    if (!isNonEmptyString(article.coverPath)) {
      errors.push('coverPath must be a string');
    } else if (!fs.existsSync(resolvePath(baseDir, article.coverPath))) {
      errors.push(`coverPath does not exist: ${article.coverPath}`);
    }
  }

  if (article.assetsDir !== undefined && article.assetsDir !== '') {
    if (!isNonEmptyString(article.assetsDir)) {
      errors.push('assetsDir must be a string');
    } else if (!fs.existsSync(resolvePath(baseDir, article.assetsDir))) {
      warnings.push(`assetsDir does not exist: ${article.assetsDir}`);
    }
  }

  for (const [idx, image] of (article.images || []).entries()) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      errors.push(`images[${idx}] must be an object`);
      continue;
    }
    const filePath = image.path || image.filePath;
    if (!filePath) {
      warnings.push(`images[${idx}] has no path`);
      continue;
    }
    if (!isNonEmptyString(filePath)) {
      errors.push(`images[${idx}] path must be a string`);
      continue;
    }
    if (!fs.existsSync(resolvePath(baseDir, filePath))) errors.push(`images[${idx}] path does not exist: ${filePath}`);
  }
}

function resolvePath(baseDir, value) {
  if (path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

module.exports = { validateArticlePackage };
