"""Supported languages and the engine that handles each one.

This file is the source of truth. After editing, regenerate the apps' copy with:
    python -m app.languages > ../packages/shared/src/languages.generated.ts

Fields:
- nllb:    FLORES-200 code for NLLB-200 translation
- whisper: Whisper language code, or None when Whisper can't transcribe it
- indic:   AI4Bharat IndicConformer code (better for Indian speech), or None
- mms:     suffix for facebook/mms-tts-<code> (single neutral voice), or None
- kokoro:  (pipeline code, female voice, male voice) for the Kokoro voice engine, or None
- parler:  True when AI4Bharat Indic Parler-TTS has male and female voices for it
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    code: str
    name: str
    native: str
    hello: str
    region: str
    nllb: str
    whisper: str | None
    mms: str | None
    latin: bool = False
    indic: str | None = None
    kokoro: tuple[str, str | None, str | None] | None = None
    parler: bool = False

    @property
    def speech_input(self) -> bool:
        return bool(self.whisper or self.indic)


SA, EA, EU, ME, AF = "South Asia", "East & Southeast Asia", "Europe & Americas", "Middle East & Central Asia", "Africa"

LANGUAGES: list[Language] = [
    # South Asia
    Language("hi-IN", "Hindi", "हिन्दी", "नमस्ते", SA, "hin_Deva", "hi", "hin", indic="hi", parler=True),
    Language("bn-IN", "Bengali", "বাংলা", "নমস্কার", SA, "ben_Beng", "bn", "ben", indic="bn", parler=True),
    Language("mr-IN", "Marathi", "मराठी", "नमस्कार", SA, "mar_Deva", "mr", "mar", indic="mr", parler=True),
    Language("gu-IN", "Gujarati", "ગુજરાતી", "નમસ્તે", SA, "guj_Gujr", "gu", "guj", indic="gu", parler=True),
    Language("pa-IN", "Punjabi", "ਪੰਜਾਬੀ", "ਸਤ ਸ੍ਰੀ ਅਕਾਲ", SA, "pan_Guru", "pa", "pan", indic="pa", parler=True),
    Language("ta-IN", "Tamil", "தமிழ்", "வணக்கம்", SA, "tam_Taml", "ta", "tam", indic="ta", parler=True),
    Language("te-IN", "Telugu", "తెలుగు", "నమస్కారం", SA, "tel_Telu", "te", "tel", indic="te", parler=True),
    Language("kn-IN", "Kannada", "ಕನ್ನಡ", "ನಮಸ್ಕಾರ", SA, "kan_Knda", "kn", "kan", indic="kn", parler=True),
    Language("ml-IN", "Malayalam", "മലയാളം", "നമസ്കാരം", SA, "mal_Mlym", "ml", "mal", indic="ml", parler=True),
    Language("or-IN", "Odia", "ଓଡ଼ିଆ", "ନମସ୍କାର", SA, "ory_Orya", None, "ory", indic="or", parler=True),
    Language("as-IN", "Assamese", "অসমীয়া", "নমস্কাৰ", SA, "asm_Beng", "as", "asm", indic="as", parler=True),
    Language("ur-IN", "Urdu", "اردو", "آداب", SA, "urd_Arab", "ur", "urd-script_arabic", indic="ur", parler=True),
    Language("ne-NP", "Nepali", "नेपाली", "नमस्ते", SA, "npi_Deva", "ne", "npi", indic="ne", parler=True),
    Language("si-LK", "Sinhala", "සිංහල", "ආයුබෝවන්", SA, "sin_Sinh", "si", "sin"),
    # East & Southeast Asia
    Language("zh-CN", "Chinese (Mandarin)", "中文", "你好", EA, "zho_Hans", "zh", None, kokoro=("z", "zf_xiaobei", "zm_yunjian")),
    Language("yue-HK", "Cantonese", "粵語", "你好", EA, "yue_Hant", "yue", None),
    Language("ja-JP", "Japanese", "日本語", "こんにちは", EA, "jpn_Jpan", "ja", None, kokoro=("j", "jf_alpha", "jm_kumo")),
    Language("ko-KR", "Korean", "한국어", "안녕하세요", EA, "kor_Hang", "ko", "kor"),
    Language("th-TH", "Thai", "ไทย", "สวัสดี", EA, "tha_Thai", "th", "tha"),
    Language("vi-VN", "Vietnamese", "Tiếng Việt", "Xin chào", EA, "vie_Latn", "vi", "vie", latin=True),
    Language("id-ID", "Indonesian", "Bahasa Indonesia", "Halo", EA, "ind_Latn", "id", "ind", latin=True),
    Language("ms-MY", "Malay", "Bahasa Melayu", "Helo", EA, "zsm_Latn", "ms", "zlm", latin=True),
    Language("fil-PH", "Filipino", "Filipino", "Kumusta", EA, "tgl_Latn", "tl", "tgl", latin=True),
    Language("km-KH", "Khmer", "ខ្មែរ", "សួស្តី", EA, "khm_Khmr", "km", "khm"),
    Language("lo-LA", "Lao", "ລາວ", "ສະບາຍດີ", EA, "lao_Laoo", "lo", "lao"),
    Language("my-MM", "Burmese", "မြန်မာ", "မင်္ဂလာပါ", EA, "mya_Mymr", "my", "mya"),
    # Europe & Americas
    Language("en-US", "English (US)", "English", "Hello", EU, "eng_Latn", "en", "eng", latin=True, kokoro=("a", "af_heart", "am_michael")),
    Language("en-GB", "English (UK)", "English", "Hello", EU, "eng_Latn", "en", "eng", latin=True, kokoro=("b", "bf_emma", "bm_george")),
    Language("es-ES", "Spanish", "Español", "Hola", EU, "spa_Latn", "es", "spa", latin=True, kokoro=("e", "ef_dora", "em_alex")),
    Language("fr-FR", "French", "Français", "Bonjour", EU, "fra_Latn", "fr", "fra", latin=True, kokoro=("f", "ff_siwis", None)),
    Language("de-DE", "German", "Deutsch", "Hallo", EU, "deu_Latn", "de", "deu", latin=True),
    Language("it-IT", "Italian", "Italiano", "Ciao", EU, "ita_Latn", "it", None, latin=True, kokoro=("i", "if_sara", "im_nicola")),
    Language("pt-PT", "Portuguese (Portugal)", "Português", "Olá", EU, "por_Latn", "pt", "por", latin=True),
    Language("pt-BR", "Portuguese (Brazil)", "Português", "Olá", EU, "por_Latn", "pt", "por", latin=True, kokoro=("p", "pf_dora", "pm_alex")),
    Language("nl-NL", "Dutch", "Nederlands", "Hallo", EU, "nld_Latn", "nl", "nld", latin=True),
    Language("el-GR", "Greek", "Ελληνικά", "Γεια σας", EU, "ell_Grek", "el", "ell"),
    Language("tr-TR", "Turkish", "Türkçe", "Merhaba", EU, "tur_Latn", "tr", "tur", latin=True),
    Language("ru-RU", "Russian", "Русский", "Здравствуйте", EU, "rus_Cyrl", "ru", "rus"),
    Language("uk-UA", "Ukrainian", "Українська", "Привіт", EU, "ukr_Cyrl", "uk", "ukr"),
    Language("pl-PL", "Polish", "Polski", "Dzień dobry", EU, "pol_Latn", "pl", "pol", latin=True),
    Language("cs-CZ", "Czech", "Čeština", "Dobrý den", EU, "ces_Latn", "cs", "ces", latin=True),
    Language("hu-HU", "Hungarian", "Magyar", "Jó napot", EU, "hun_Latn", "hu", "hun", latin=True),
    Language("ro-RO", "Romanian", "Română", "Bună ziua", EU, "ron_Latn", "ro", "ron", latin=True),
    Language("sv-SE", "Swedish", "Svenska", "Hej", EU, "swe_Latn", "sv", "swe", latin=True),
    Language("nb-NO", "Norwegian", "Norsk", "Hei", EU, "nob_Latn", "no", "nob", latin=True),
    Language("da-DK", "Danish", "Dansk", "Hej", EU, "dan_Latn", "da", "dan", latin=True),
    Language("fi-FI", "Finnish", "Suomi", "Hei", EU, "fin_Latn", "fi", "fin", latin=True),
    Language("hr-HR", "Croatian", "Hrvatski", "Bok", EU, "hrv_Latn", "hr", "hrv", latin=True),
    Language("sr-RS", "Serbian", "Српски", "Здраво", EU, "srp_Cyrl", "sr", "srp"),
    Language("bg-BG", "Bulgarian", "Български", "Здравейте", EU, "bul_Cyrl", "bg", "bul"),
    Language("is-IS", "Icelandic", "Íslenska", "Halló", EU, "isl_Latn", "is", "isl", latin=True),
    # Middle East & Central Asia
    Language("ar-SA", "Arabic", "العربية", "مرحبا", ME, "arb_Arab", "ar", "ara"),
    Language("fa-IR", "Persian", "فارسی", "سلام", ME, "pes_Arab", "fa", "fas"),
    Language("he-IL", "Hebrew", "עברית", "שלום", ME, "heb_Hebr", "he", "heb"),
    Language("ka-GE", "Georgian", "ქართული", "გამარჯობა", ME, "kat_Geor", "ka", "kat"),
    Language("hy-AM", "Armenian", "Հայերեն", "Բարև", ME, "hye_Armn", "hy", "hye"),
    Language("kk-KZ", "Kazakh", "Қазақ", "Сәлем", ME, "kaz_Cyrl", "kk", "kaz"),
    Language("uz-UZ", "Uzbek", "Oʻzbek", "Salom", ME, "uzn_Latn", "uz", "uzb-script_latin", latin=True),
    Language("az-AZ", "Azerbaijani", "Azərbaycan", "Salam", ME, "azj_Latn", "az", "azj-script_latin", latin=True),
    Language("mn-MN", "Mongolian", "Монгол", "Сайн байна уу", ME, "khk_Cyrl", "mn", "khk"),
    # Africa
    Language("sw-KE", "Swahili", "Kiswahili", "Habari", AF, "swh_Latn", "sw", "swh", latin=True),
    Language("am-ET", "Amharic", "አማርኛ", "ሰላም", AF, "amh_Ethi", "am", "amh"),
    Language("af-ZA", "Afrikaans", "Afrikaans", "Hallo", AF, "afr_Latn", "af", "afr", latin=True),
    Language("yo-NG", "Yoruba", "Yorùbá", "Báwo ni", AF, "yor_Latn", "yo", "yor", latin=True),
]

BY_CODE: dict[str, Language] = {lang.code: lang for lang in LANGUAGES}
REGIONS = [SA, EA, EU, ME, AF]

# Codes renamed since earlier app versions, so old saved settings keep working.
ALIASES = {"ur-PK": "ur-IN", "tl-PH": "fil-PH", "no-NO": "nb-NO"}


def find(code: str) -> Language | None:
    return BY_CODE.get(ALIASES.get(code, code))


def gender_voices(lang: Language) -> list[str]:
    """Which voice genders the server's engines can offer (before checking what's installed)."""
    genders: set[str] = set()
    if lang.parler:
        genders |= {"female", "male"}
    if lang.kokoro:
        if lang.kokoro[1]:
            genders.add("female")
        if lang.kokoro[2]:
            genders.add("male")
    return sorted(genders)


def typescript() -> str:
    rows = []
    for l in LANGUAGES:
        item = {"code": l.code, "name": l.name, "native": l.native, "hello": l.hello, "region": l.region}
        if l.latin:
            item["latin"] = True
        if not l.speech_input:
            item["speechInput"] = False
        rows.append("  " + json.dumps(item, ensure_ascii=False) + ",")
    return (
        "// Generated from backend/app/languages.py by `python -m app.languages`. Do not edit by hand.\n"
        "import type { Language } from \"./languages\";\n\n"
        f"export const REGIONS = {json.dumps(REGIONS)} as const;\n\n"
        "export const GENERATED_LANGUAGES: Language[] = [\n" + "\n".join(rows) + "\n];\n"
    )


if __name__ == "__main__":
    sys.stdout.write(typescript())
