function stringsIn(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, output);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      output.push(key);
      stringsIn(item, output);
    }
  }
  return output;
}

export function unsafeContentReason(value) {
  const strings = stringsIn(value);
  for (const text of strings) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text)) return 'private-key-marker';
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/iu.test(text)) {
      return 'email-address';
    }
    if (/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u.test(text)) {
      return 'jwt';
    }
    if (/\b(?:bearer\s+eyJ|apptoken\s*[:=]|password\s*[:=]|secret\s*[:=])\S+/iu.test(text)) {
      return 'credential-marker';
    }
    if (/(?:^|[\s"'])(?:[A-Za-z]:\\|\\\\)[^\s"']+/u.test(text)) return 'absolute-path';
    if (/(?:^|[\s"'])\/(?:home|Users|private|var\/lib)\//u.test(text)) return 'absolute-path';
  }
  return null;
}
