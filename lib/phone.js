// Phone numbers for the texting channel.
//
// Everything is stored in E.164 (+15551234567) so one person always has one
// key, however their number was typed in the CSV — "(555) 123-4567", "555.123.4567"
// and "+1 555 123 4567" all collapse to the same string. That key is what the
// queue dedupes on, what the Mac relay sends to, and what inbound iMessages
// are matched back to.
//
// The area code also tells us roughly where someone is, which is how the queue
// keeps to daytime hours in the RECIPIENT's timezone rather than ours: a text
// landing at 6am is both rude and, under the TCPA, outside the legal window.

// NANP area code -> IANA timezone. Unlisted codes fall back to Central, the
// middle of the country, so an unknown number is never texted at a time that
// is wrong by more than an hour in either direction.
const EASTERN = '203 475 860 959 302 202 239 305 321 352 386 407 448 561 656 689 727 754 772 786 813 863 904 941 954 229 404 470 478 678 706 762 770 912 943 219 260 317 463 574 765 812 930 502 606 859 207 240 301 410 443 667 339 351 413 508 617 774 781 857 978 231 248 269 313 517 586 616 679 734 810 906 947 989 603 201 551 609 640 732 848 856 862 908 973 212 315 329 332 347 363 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934 252 336 704 743 828 910 919 980 984 216 220 234 326 330 380 419 436 440 513 567 614 740 937 215 223 267 272 412 445 484 570 582 610 717 724 814 835 878 401 803 839 843 854 864 423 865 802 276 434 540 571 703 757 804 826 948 304 681';
const CENTRAL = '205 251 256 334 483 659 327 479 501 870 850 217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 872 319 515 563 641 712 316 620 785 913 270 364 225 318 337 504 985 218 320 507 612 651 763 952 228 601 662 769 235 314 417 557 573 636 660 816 308 402 531 701 405 539 572 580 918 605 615 629 731 901 931 210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979 262 274 414 534 608 715 920';
const MOUNTAIN = '303 719 720 970 983 208 986 406 505 575 385 435 801 307 915';
const ARIZONA = '480 520 602 623 928';          // no daylight saving
const PACIFIC = '209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951 702 725 775 458 503 541 971 206 253 360 425 509 564';

const ZONES = new Map();
const addZone = (codes, tz) => { for (const c of codes.split(' ')) ZONES.set(c, tz); };
addZone(EASTERN, 'America/New_York');
addZone(CENTRAL, 'America/Chicago');
addZone(MOUNTAIN, 'America/Denver');
addZone(ARIZONA, 'America/Phoenix');
addZone(PACIFIC, 'America/Los_Angeles');
ZONES.set('907', 'America/Anchorage');
ZONES.set('808', 'Pacific/Honolulu');
const DEFAULT_ZONE = 'America/Chicago';

// A North American number is valid when the area code and the exchange both
// start 2-9, and neither is a service code (N11 like 411/911).
function validNanp(ten) {
  if (!/^\d{10}$/.test(ten)) return false;
  const area = ten.slice(0, 3);
  const exchange = ten.slice(3, 6);
  if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange)) return false;
  if (area[1] === '1' && area[2] === '1') return false;
  if (exchange[1] === '1' && exchange[2] === '1') return false;
  // 555-0100..555-0199 is the range reserved for fiction; other 555 numbers
  // are real, so only the fictional block and a 555 area code are refused.
  if (area === '555') return false;
  if (exchange === '555' && /^01\d\d$/.test(ten.slice(6))) return false;
  return true;
}

// Any input -> "+15551234567", or '' when it is not a number we can text.
// Non-North-American numbers are kept as-is (iMessage is worldwide) as long as
// they carry a country code and a plausible length.
function normalize(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // An extension is not part of the number and must not become digits.
  s = s.replace(/\b(?:ext|x|extension)\.?\s*\d+\s*$/i, '');
  const plus = s.trimStart().startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (!plus) {
    if (digits.length === 10) return validNanp(digits) ? `+1${digits}` : '';
    if (digits.length === 11 && digits[0] === '1') return validNanp(digits.slice(1)) ? `+${digits}` : '';
    // No "+" and not a North American length: we cannot guess a country code.
    return '';
  }
  if (digits.length === 11 && digits[0] === '1') return validNanp(digits.slice(1)) ? `+${digits}` : '';
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return '';
}

const isUS = (e164) => /^\+1\d{10}$/.test(String(e164 || ''));

// "(555) 123-4567" for North America, the E.164 form otherwise.
function display(e164) {
  const v = String(e164 || '');
  if (!isUS(v)) return v;
  const d = v.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function zone(e164) {
  if (!isUS(e164)) return DEFAULT_ZONE;
  return ZONES.get(String(e164).slice(2, 5)) || DEFAULT_ZONE;
}

// Wall-clock hour, minute and weekday where the recipient is (0 = Sunday).
function localTime(e164, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone(e164), hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour: Number(get('hour')), minute: Number(get('minute')), day: days[get('weekday')] ?? 1 };
}

// Is it a reasonable hour to text this person right now?
// `days` is the set of weekday numbers that are allowed (default Mon-Sat).
function withinHours(e164, { startHour = 9, endHour = 19, days = [1, 2, 3, 4, 5, 6] } = {}, now = new Date()) {
  const { hour, day } = localTime(e164, now);
  if (!days.includes(day)) return false;
  return hour >= startHour && hour < endHour;
}

// When this number next enters its sending window, as a Date. Used to schedule
// rather than spin: an evening queue simply resumes in the morning.
function nextWindowStart(e164, opts = {}, now = new Date()) {
  const { startHour = 9, endHour = 19, days = [1, 2, 3, 4, 5, 6] } = opts;
  if (withinHours(e164, { startHour, endHour, days }, now)) return new Date(now);
  const t = localTime(e164, now);
  let wait;   // minutes until the window opens
  const minutesNow = t.hour * 60 + t.minute;
  if (t.hour < startHour && days.includes(t.day)) wait = startHour * 60 - minutesNow;
  else wait = (24 * 60 - minutesNow) + startHour * 60;   // tomorrow morning
  let at = new Date(now.getTime() + wait * 60 * 1000);
  // Step over any days that are not allowed (Sundays by default).
  for (let i = 0; i < 8 && !days.includes(localTime(e164, at).day); i++) {
    at = new Date(at.getTime() + 24 * 3600 * 1000);
  }
  return at;
}

// Anything that reads as "stop texting me". Matched against a whole reply so a
// bare "STOP" opts out but "stop by the office Tuesday" does not.
const OPT_OUT = /^\s*(?:please\s+|pls\s+|no,?\s+|no\s+thanks,?\s+)?(?:stop|stopall|unsubscribe|end|quit|cancel|opt\s?out|remove me|take me off( (this|your) list)?|do ?not ?(?:text|contact|message) ?me|don'?t (?:text|contact|message) me(?: again)?)(?:\s+please)?\s*[.!]*\s*$/i;
const optedOut = (text) => OPT_OUT.test(String(text || ''));

module.exports = { normalize, display, zone, localTime, withinHours, nextWindowStart, optedOut, isUS, validNanp, DEFAULT_ZONE };
