#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
☆ XGO Bot v2.0 — AI Assistant with Tree-Style Reasoning, Tools & Skills
Модель: Claude Opus 4.7 (через FreeModel API)
Исправленная версия: расширенное обнаружение тулов, отправка файлов, гибкое дерево
"""

import os
os.environ.setdefault("PYDANTIC_SKIP_VALIDATING_CORE_SCHEMAS", "true")

import asyncio
import base64
import hashlib
import hmac
import html
import io
import json
import logging
import os
import sys
import re
import math
import random
import secrets
import shutil
import subprocess
import time
import urllib.parse
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

import aiohttp
from aiohttp import web
from aiogram import Bot, Dispatcher, F, Router
from aiogram.enums import ParseMode
from aiogram.filters import Command
from aiogram.types import (
    BotCommand,
    BotCommandScopeChat,
    BotCommandScopeDefault,
    CallbackQuery,
    ErrorEvent,
    ForceReply,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InlineQuery,
    InlineQueryResultArticle,
    InputTextMessageContent,
    Message,
    FSInputFile,
)
from aiogram.client.default import DefaultBotProperties

# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════
OWNER_ID = 7467472235
BOT_TOKEN = "8998349951:AAGi271-nxkCKR-mnvSEdvOzBtmfMhiEyNQ"

FREEMODEL_TOKEN = "sk-HOu2ckIlNJTmK9zg83C9E51f84884a9eB83dCe3f9dE97371"
FREEMODEL_URL = "https://aihubmix.com/v1"

MODEL_NAME = "gpt-5.5-free"

DEFAULT_MAX_TOKENS = 4096
DEFAULT_TEMPERATURE = 0.7
DEFAULT_TOP_P = 0.9

MAX_PAGE_CHARS = 3500
MAX_PAGES = 20

# До 15 шагов агенту разрешено рассуждать и вызывать тулы за один запрос.
# Общий таймаут ниже считается именно от этого числа, а не берётся с потолка —
# так честный сложный запрос (несколько тулов подряd, включая exec) не
# обрывается раньше времени, но при этом есть жёсткий верхний предел.
AGENT_MAX_STEPS = 15

# Таймаут ОДНОГО HTTP-запроса к модели. Без него зависший/медленный ответ
# API мог держать один запрос десятками минут, из-за чего процесс выглядел
# подвисшим, Telegram отклонял protracted edit_message_text и бот приходилось
# перезапускать вручную — а рестарт обнулял pending_prompts/_response_cache
# в памяти, откуда и "данные устарели" на всех старых кнопках.
MODEL_CALL_TIMEOUT_SECONDS = 60

# TTL для in-memory кэшей кнопок. Без явного TTL записи копились в памяти
# бесконечно (утечка) и "протухали" только скачком при рестарте процесса —
# отсюда непредсказуемое массовое "данные устарели". Теперь это предсказуемо:
# кнопки живут фиксированное время, а не до следующего краша.
PENDING_PROMPT_TTL_SECONDS = 6 * 3600     # кнопки "Сгенерировать"/параметры/скиллы
RESPONSE_CACHE_TTL_SECONDS = 24 * 3600    # кнопки пагинации/дерева/файлов готового ответа
CACHE_CLEANUP_INTERVAL_SECONDS = 900      # как часто проверяем и чистим

# Базовая директория рядом со скриптом — переживает рестарты процесса
# (в отличие от /tmp, который на некоторых хостингах чистится)
BASE_DIR = Path(__file__).resolve().parent

FILES_DIR = BASE_DIR / "xgo_files"
FILES_DIR.mkdir(exist_ok=True)

# Медиа, присланное юзерами боту (фото/видео/документы) -- отдаётся панели
# через статический /media/ роут для галереи в мини-чате. Имена файлов
# всегда рандомные (uuid), поэтому угадать чужой путь нельзя даже без
# отдельной авторизации на сам файл.
MEDIA_DIR = BASE_DIR / "xgo_media"
MEDIA_DIR.mkdir(exist_ok=True)

DATA_DIR = BASE_DIR / "xgo_data"
DATA_DIR.mkdir(exist_ok=True)

APPROVED_USERS_FILE = DATA_DIR / "approved_users.json"
BLOCKED_USERS_FILE = DATA_DIR / "blocked_users.json"
PENDING_REQUESTS_FILE = DATA_DIR / "pending_requests.json"
GITHUB_CONNECTIONS_FILE = DATA_DIR / "github_connections.json"
PENDING_PROMPTS_FILE = DATA_DIR / "pending_prompts.json"
RESPONSE_CACHE_FILE = DATA_DIR / "response_cache.json"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Мультипровайдерный fallback ─────────────────────────────────────
# Основной провайдер — FreeModel (как и раньше). Дополнительные резервные
# провайдеры настраиваются через переменную окружения FALLBACK_PROVIDERS —
# JSON-массив вида:
#   [{"url": "https://api.example.com/v1", "token": "sk-...", "model": "gpt-4o"}]
# Если основной провайдер упал (таймаут / HTTP 4xx-5xx / сетевая ошибка),
# запрос автоматически уходит следующему по списку — без падения генерации
# целиком. Секреты намеренно НЕ хардкодятся здесь: их нужно задать в
# переменных окружения хостинга.
def _load_fallback_providers() -> list[dict]:
    raw = os.environ.get("FALLBACK_PROVIDERS", "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            raise ValueError("FALLBACK_PROVIDERS must be a JSON array")
        return parsed
    except Exception as e:
        logger.error(f"Failed to parse FALLBACK_PROVIDERS env var: {e}")
        return []

FALLBACK_PROVIDERS = _load_fallback_providers()

# Общий дедлайн на весь agent.run() должен вмещать честный "плохой день":
# до MAX_STEPS шагов рассуждения (каждый — вызов модели, возможно с перебором
# нескольких fallback-провайдеров подряд, если основной недоступен) + вызовы
# тулов между ними + thinking-note в начале + возможная форс-финализация.
# Раньше это было захардкожено в 150с — при 3-4 шагах с тулами (обычное дело
# для сложного запроса) агент почти гарантированно упирался в дедлайн ещё до
# честного завершения, отсюда участившиеся "Generation error"/"превышено
# время ожидания" даже там, где каждый отдельный шаг отрабатывал нормально.
_EXEC_TOOL_TIMEOUT_BUFFER = 25        # запас на самый долгий тул (exec) сверх вызова модели
_MAX_PROVIDERS_PER_STEP = max(1, len(FALLBACK_PROVIDERS) + 1)  # основной + все резервные
AGENT_TOTAL_TIMEOUT_SECONDS = (AGENT_MAX_STEPS + 2) * (
    MODEL_CALL_TIMEOUT_SECONDS * _MAX_PROVIDERS_PER_STEP + _EXEC_TOOL_TIMEOUT_BUFFER
)

# ═══════════════════════════════════════════════════════════════════
# UNICODE SYMBOL SET
# ═══════════════════════════════════════════════════════════════════
SYM = {
    "bot": "◈", "version": "◉", "sparkle": "✦", "star": "★", "star_empty": "☆",
    "diamond": "◆", "diamond_empty": "◇", "circle": "●", "circle_empty": "○",
    "bullet": "•", "arrow": "➤", "arrow_right": "➜", "arrow_small": "›",
    "pointer": "▸", "tree_t": "├─", "tree_l": "└─", "tree_v": "│",
    "tree_h": "─", "tree_branch": "├", "tree_corner": "└", "tree_pipe": "│",
    "think": "✧", "brain": "◉", "prompt": "✎", "answer": "✦",
    "code": "⌘", "link": "⛓", "time": "◷", "speed": "⚡",
    "tokens": "∞", "page": "◫", "fire": "✺",
    "check": "✓", "cross": "✗", "lock": "◉", "unlock": "○",
    "pending": "◷", "warning": "⚠", "error": "✗", "success": "✓",
    "divider": "─", "divider_double": "═", "dot": "·", "dash": "–",
    "info": "ℹ", "settings": "⚙", "stats": "◫", "users": "◉",
    "queue": "◷", "notif": "◉", "clear": "◌", "regen": "↻",
    "back": "◀", "forward": "▶", "refresh": "↻", "pin": "◈", "tag": "◇",
    "continue": "➜", "regen_prompt": "↻", "history": "◫", "generate": "⚡",
    "typing": "✦", "quote": "❝", "quote_end": "❞",
    "tool": "⚙", "search": "◎", "file": "▤", "table": "▦",
    "archive": "◫", "skill": "◆", "branch": "╟", "leaf": "❋",
    "root": "▲", "node": "◆", "step": "➤", "process": "⚙",
    "analyze": "◎", "decide": "◆", "result": "◉", "memory": "▤",
    "upload": "△", "download": "▽", "image": "▥", "chart": "▦",
}

# ═══════════════════════════════════════════════════════════════════
# DATA STRUCTURES
# ═══════════════════════════════════════════════════════════════════

@dataclass
class UserSession:
    user_id: int
    messages: list[dict] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    model: Optional[str] = None  # None = использовать активную модель из ProviderRegistry
    awaiting_input: bool = False  # true после кнопки "Продолжить" -- следующий текстовый reply уходит как продолжение
    awaiting_continue_request_id: Optional[str] = None  # request_id диалога, который продолжаем (контекст предыдущего ответа)
    awaiting_ask_user: Optional[tuple] = None  # (pause_id, q_idx) после кнопки "Свой ответ" на вопросе ask_user
    max_tokens: int = DEFAULT_MAX_TOKENS
    temperature: float = DEFAULT_TEMPERATURE
    top_p: float = DEFAULT_TOP_P
    # ПО УМОЛЧАНИЮ ВСЕ ТУЛЫ АКТИВНЫ
    preferred_tools: list[str] = field(default_factory=lambda: ["search", "file_create", "table", "chart", "archive", "exec", "presentation", "github_commit", "github_read", "github_actions"])
    active_skills: list[str] = field(default_factory=list)
    # Временное состояние многошагового ввода данных для подключения GitHub:
    # {"step": "token"|"repo"|"branch", "token": str, "owner": str, "repo": str}
    github_setup: Optional[dict] = None

    def add_message(self, role: str, content: str):
        self.messages.append({"role": role, "content": content})
        self.updated_at = time.time()
        if len(self.messages) > 40:
            self.messages = self.messages[-40:]

    def get_context_messages(self, recent_verbatim: int = 4, history_horizon: int = 24) -> list[dict]:
        """"Caveman"-компрессия истории для отправки модели: последние
        `recent_verbatim` сообщений идут дословно (нужна точность для
        текущего диалога), а до `history_horizon` более старых сообщений
        сжимаются в один компактный дайджест из коротких однострочных
        заметок вместо полного текста.

        Честно говоря, что это даёт: раньше бот отправлял последние 10
        сообщений ПОЛНОСТЬЮ и терял всё, что было раньше, — это было дёшево
        по токенам, но ценой резкой потери памяти о разговоре. Здесь тот же
        или меньший токен-бюджет покрывает куда больший горизонт (до 24+4
        сообщений вместо 10) — экономия именно в этом: помнить дольше и
        дешевле, а не переплачивать за дословное хранение старых реплик,
        которые для текущего ответа важны только своей сутью.

        Компрессия детерминированная и локальная — без дополнительного
        LLM-вызова на суммаризацию, то есть без лишней задержки/стоимости."""
        if len(self.messages) <= recent_verbatim:
            return list(self.messages)

        recent_messages = self.messages[-recent_verbatim:]
        old_messages = self.messages[-(recent_verbatim + history_horizon):-recent_verbatim]
        if not old_messages:
            return recent_messages

        digest_lines = []
        for msg in old_messages:
            role_tag = "U" if msg["role"] == "user" else "A"
            text = re.sub(r"\s+", " ", msg["content"]).strip()
            # Примитивная, но эффективная компрессия в духе "caveman":
            # никакой грамматики, только суть в пределах ~120 символов.
            if len(text) > 120:
                text = text[:120] + "…"
            digest_lines.append(f"[{role_tag}] {text}")

        digest = (
            "Earlier conversation (compressed, for context only — not verbatim):\n"
            + "\n".join(digest_lines)
        )
        return [{"role": "system", "content": digest}] + recent_messages

@dataclass
class PendingRequest:
    request_id: str
    user_id: int
    username: str
    first_name: str
    query: str
    chat_id: int
    message_id: int
    created_at: float = field(default_factory=time.time)

@dataclass
class GenerationParams:
    max_tokens: int = DEFAULT_MAX_TOKENS
    temperature: float = DEFAULT_TEMPERATURE
    top_p: float = DEFAULT_TOP_P

@dataclass
class GitHubConnection:
    user_id: int
    token: str          # personal access token (repo scope)
    owner: str           # repo owner/org
    repo: str            # repo name
    branch: str = "main"
    connected_at: float = field(default_factory=time.time)

@dataclass
class ToolResult:
    tool_name: str
    success: bool
    result: str
    metadata: dict = field(default_factory=dict)

# ═══════════════════════════════════════════════════════════════════
# SKILL SYSTEM
# ═══════════════════════════════════════════════════════════════════

class Skill:
    def __init__(self, name: str, description: str, system_prompt: str, icon: str = "◆"):
        self.name = name
        self.description = description
        self.system_prompt = system_prompt
        self.icon = icon
        self.enabled = True

    def get_prompt(self, user_query: str) -> str:
        return f"{self.system_prompt}\n\nUser request: {user_query}"

class SkillManager:
    def __init__(self):
        self.skills: Dict[str, Skill] = {}
        self._register_default_skills()

    def _register_default_skills(self):
        self.register(Skill(
            name="code_writer",
            description="Писать чистый, документированный код на любых языках",
            icon="⌘",
            system_prompt="""You are an expert software developer. When writing code:
- Always provide complete, working code examples
- Include comments explaining complex logic
- Use best practices and modern patterns
- Include error handling where appropriate
- Specify the language in code blocks
- If multiple files are needed, clearly separate them with headers"""
        ))
        self.register(Skill(
            name="analyst",
            description="Анализировать данные, делать выводы, строить стратегии",
            icon="◎",
            system_prompt="""You are a senior data analyst and business strategist. When analyzing:
- Break down complex problems into components
- Consider multiple perspectives and edge cases
- Provide actionable insights and recommendations
- Use structured reasoning (pros/cons, SWOT, etc. when appropriate)
- Cite logical foundations for your conclusions
- Suggest next steps or alternative approaches"""
        ))
        self.register(Skill(
            name="creative_writer",
            description="Писать креативные тексты, сценарии, истории, поэзию",
            icon="✎",
            system_prompt="""You are a creative writing expert. When creating content:
- Adapt tone and style to the subject matter
- Use vivid, engaging language
- Structure content with clear flow and pacing
- Consider the target audience
- Provide multiple variations when requested
- Polish and refine the output for maximum impact"""
        ))
        self.register(Skill(
            name="debugger",
            description="Находить баги, объяснять ошибки, предлагать фиксы",
            icon="✗",
            system_prompt="""You are a debugging expert. When analyzing code or errors:
- Identify the root cause, not just symptoms
- Explain why the error occurs in simple terms
- Provide the minimal fix needed
- Suggest preventive measures for similar issues
- Test edge cases mentally and mention them
- Provide corrected code in full when applicable"""
        ))
        self.register(Skill(
            name="architect",
            description="Проектировать системы, выбирать стек, планировать архитектуру",
            icon="▲",
            system_prompt="""You are a system architect. When designing systems:
- Consider scalability, maintainability, and security
- Evaluate trade-offs between different approaches
- Suggest specific technologies with justification
- Provide diagrams or structural descriptions
- Consider deployment, monitoring, and operational concerns
- Break down into phases if the project is large"""
        ))
        self.register(Skill(
            name="teacher",
            description="Объяснять сложные темы простым языком, обучать",
            icon="◫",
            system_prompt="""You are an expert teacher. When explaining topics:
- Start with the big picture, then dive into details
- Use analogies and real-world examples
- Build concepts progressively (do not assume prior knowledge)
- Check understanding with rhetorical questions
- Summarize key takeaways at the end
- Adjust depth based on the apparent complexity of the question"""
        ))

    def register(self, skill: Skill):
        self.skills[skill.name] = skill

    def get(self, name: str) -> Optional[Skill]:
        return self.skills.get(name)

    def list_skills(self) -> List[Skill]:
        return list(self.skills.values())

    def get_active_prompt(self, active_skills: List[str], base_prompt: str) -> str:
        if not active_skills:
            return base_prompt
        skill_prompts = []
        for name in active_skills:
            skill = self.skills.get(name)
            if skill and skill.enabled:
                skill_prompts.append(f"[{skill.icon} {skill.name}]\n{skill.system_prompt}")
        if skill_prompts:
            return base_prompt + "\n\n--- ACTIVE SKILLS ---\n\n" + "\n\n".join(skill_prompts)
        return base_prompt

# ═══════════════════════════════════════════════════════════════════
# TOOL SYSTEM — с расширенным обнаружением
# ═══════════════════════════════════════════════════════════════════

class Tool:
    def __init__(self, name: str, description: str, icon: str):
        self.name = name
        self.description = description
        self.icon = icon

    async def execute(self, query: str, **kwargs) -> ToolResult:
        raise NotImplementedError

SEARXNG_INSTANCES_CACHE_FILE = DATA_DIR / "searxng_instances_cache.json"
SEARXNG_INSTANCES_REFRESH_SECONDS = 6 * 3600  # обновляем список раз в 6 часов
SEARXNG_INSTANCES_LIST_URL = "https://searx.space/data/instances.json"
# Резервный статический список — используется только если и кэш на диске
# пуст, и searx.space недоступен (например при самом первом запуске бота
# без интернета к тому моменту). Не единственный источник правды.
SEARXNG_FALLBACK_STATIC = [
    "https://searx.be",
    "https://search.inetol.net",
    "https://priv.au",
    "https://baresearch.org",
    "https://searx.tiekoetter.com",
    "https://opnxng.com",
]

class WebSearchTool(Tool):
    """Веб-поиск с цепочкой источников по надёжности:
      1) SearXNG — список инстансов подтягивается динамически с
         https://searx.space/data/instances.json (официальный, обновляемый
         каждые 24ч реестр публичных инстансов), кэшируется на диск и
         обновляется раз в SEARXNG_INSTANCES_REFRESH_SECONDS. Инстансы
         проверяются НАЛИЧИЕМ рабочего JSON API перед использованием —
         многие публичные инстансы отдают HTTP 200, но с отключённым
         в settings.yml JSON-форматом (тогда 200 приходит с HTML-страницей
         вместо JSON, и раньше это тихо считалось "нет результатов").
         Инстансы опрашиваются с ограниченной параллельностью, чтобы не
         упереться в первый же лежащий/забаненный сервер.
      2) DuckDuckGo HTML-скрейпинг (html/lite) — полноценные веб-результаты,
         а не "instant answer".
      3) DuckDuckGo Instant Answer API — оставлен строго ПОСЛЕДНИМ резервом:
         это НЕ веб-поиск, а точечные справочные карточки ("что такое X",
         "кто такой Y"). На произвольный поисковый запрос почти всегда
         пустой ответ, поэтому раньше стоял вторым и создавал ложное
         ощущение "поиск не работает".
    Если все источники недоступны — тул честно возвращает ошибку вместо
    того, чтобы тихо промолчать и заставить модель придумывать ответ."""

    # Класс-уровневое состояние — общее для всех вызовов тула в процессе,
    # чтобы не обновлять список инстансов на каждый /ask.
    _instances_cache: List[str] = []
    _instances_fetched_at: float = 0.0
    _instances_lock: Optional[asyncio.Lock] = None

    def __init__(self):
        super().__init__("search", "Веб-поиск информации", "◎")
        self.ia_url = "https://api.duckduckgo.com/"
        self.ddg_urls = [
            "https://html.duckduckgo.com/html/",
            "https://lite.duckduckgo.com/lite/",
        ]
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
            "Referer": "https://duckduckgo.com/",
            "Origin": "https://duckduckgo.com",
        }
        if WebSearchTool._instances_lock is None:
            WebSearchTool._instances_lock = asyncio.Lock()

    async def execute(self, query: str, **kwargs) -> ToolResult:
        source_used = None

        # 1) SearXNG — приоритетный источник, с динамическим списком инстансов
        results = []
        try:
            results = await self._search_searxng(query)
            if results:
                source_used = "SearXNG"
        except Exception as e:
            logger.warning(f"SearXNG search failed: {e}")

        # 2) DuckDuckGo HTML-скрейпинг — полноценные веб-результаты
        if not results:
            try:
                results = await self._search_html(query)
                if results:
                    source_used = "DuckDuckGo HTML"
            except Exception as e:
                logger.warning(f"DDG HTML search failed: {e}")

        # 3) DuckDuckGo Instant Answer API — самый последний резерв (см. docstring)
        if not results:
            try:
                results = await self._search_instant_answer(query)
                if results:
                    source_used = "DuckDuckGo IA"
            except Exception as e:
                logger.warning(f"IA API search failed: {e}")

        if not results:
            return ToolResult(
                self.name, False,
                "No results found (SearXNG, DuckDuckGo HTML и DuckDuckGo IA API — все источники недоступны или не дали результатов)"
            )

        formatted = self._format_results(results, source_used)
        return ToolResult(
            self.name, True, formatted,
            {"results_count": len(results), "query": query, "source": source_used}
        )

    # ── Динамический список SearXNG-инстансов ──────────────────────
    @classmethod
    def _load_instances_from_disk(cls) -> Optional[dict]:
        try:
            if SEARXNG_INSTANCES_CACHE_FILE.exists():
                return json.loads(SEARXNG_INSTANCES_CACHE_FILE.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning(f"Failed to read SearXNG instances cache: {e}")
        return None

    @classmethod
    def _save_instances_to_disk(cls, instances: List[str]) -> None:
        try:
            SEARXNG_INSTANCES_CACHE_FILE.write_text(
                json.dumps({"instances": instances, "fetched_at": time.time()}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning(f"Failed to write SearXNG instances cache: {e}")

    @classmethod
    async def _fetch_instances_from_searx_space(cls) -> List[str]:
        """Тянет актуальный реестр публичных SearXNG-инстансов и берёт из
        него только те, что помечены как 'online'. searx.space обновляет
        данные раз в 24ч, поэтому мы сами кэшируем результат и опрашиваем
        его не чаще раза в несколько часов."""
        async with aiohttp.ClientSession() as session:
            async with session.get(
                SEARXNG_INSTANCES_LIST_URL,
                timeout=aiohttp.ClientTimeout(total=15),
                headers={"User-Agent": "Mozilla/5.0"},
            ) as resp:
                if resp.status != 200:
                    raise Exception(f"searx.space returned HTTP {resp.status}")
                data = await resp.json(content_type=None)

        instances = data.get("instances", {})
        candidates = []
        for url, info in instances.items():
            try:
                if not isinstance(info, dict):
                    continue
                # network_type "normal" исключает onion/i2p — они нам не нужны
                if info.get("network_type") and info.get("network_type") != "normal":
                    continue
                http_info = info.get("http", {}) or {}
                if http_info.get("status_code") not in (200, None):
                    continue
                # Финальную проверку JSON-формата всё равно делаем сами живым
                # запросом ниже — здесь только грубый предварительный отсев.
                candidates.append(url.rstrip("/"))
            except Exception:
                continue
        return candidates

    @classmethod
    async def _probe_instance_json(cls, session: aiohttp.ClientSession, instance: str) -> bool:
        """Живая проверка: инстанс реально отдаёт JSON на format=json, а не
        HTML-заглушку с 200. Короткий таймаут — это лишь пробник."""
        try:
            async with session.get(
                f"{instance}/search",
                params={"q": "test", "format": "json"},
                timeout=aiohttp.ClientTimeout(total=5),
                headers={"User-Agent": "Mozilla/5.0"},
            ) as resp:
                if resp.status != 200:
                    return False
                ctype = resp.headers.get("Content-Type", "")
                if "json" in ctype.lower():
                    return True
                # Некоторые инстансы не выставляют правильный Content-Type,
                # но всё равно отдают валидный JSON — пробуем распарсить.
                try:
                    await resp.json(content_type=None)
                    return True
                except Exception:
                    return False
        except Exception:
            return False

    @classmethod
    async def _get_working_instances(cls) -> List[str]:
        """Возвращает список рабочих (проверенных на живой JSON API)
        SearXNG-инстансов. Источники по приоритету:
          1) свежий in-memory кэш процесса
          2) свежий кэш на диске
          3) свежая загрузка с searx.space + живая проверка каждого
          4) устаревший кэш на диске (лучше, чем ничего)
          5) статический резервный список
        """
        now = time.time()
        if cls._instances_cache and (now - cls._instances_fetched_at) < SEARXNG_INSTANCES_REFRESH_SECONDS:
            return cls._instances_cache

        async with cls._instances_lock:
            # Другая корутина могла обновить кэш, пока мы ждали лок
            now = time.time()
            if cls._instances_cache and (now - cls._instances_fetched_at) < SEARXNG_INSTANCES_REFRESH_SECONDS:
                return cls._instances_cache

            disk = cls._load_instances_from_disk()
            if disk and (now - disk.get("fetched_at", 0)) < SEARXNG_INSTANCES_REFRESH_SECONDS and disk.get("instances"):
                cls._instances_cache = disk["instances"]
                cls._instances_fetched_at = disk.get("fetched_at", now)
                return cls._instances_cache

            try:
                candidates = await cls._fetch_instances_from_searx_space()
                if not candidates:
                    raise Exception("empty candidate list from searx.space")

                # Живая проверка JSON API с ограниченной параллельностью —
                # не долбим все сотни инстансов разом, но и не ждём их
                # строго по очереди (иначе первый лежащий съедает весь бюджет).
                sem = asyncio.Semaphore(12)
                working: List[str] = []

                async def _check(inst: str, session: aiohttp.ClientSession):
                    async with sem:
                        if await cls._probe_instance_json(session, inst):
                            working.append(inst)

                async with aiohttp.ClientSession() as session:
                    # Проверяем не более 60 кандидатов, чтобы не тратить
                    # десятки секунд на реестр из сотен адресов
                    await asyncio.gather(*[_check(i, session) for i in candidates[:60]])

                if not working:
                    raise Exception("no SearXNG instance passed the live JSON probe")

                cls._instances_cache = working
                cls._instances_fetched_at = now
                cls._save_instances_to_disk(working)
                logger.info(f"SearXNG: refreshed working instances list, {len(working)} alive")
                return working
            except Exception as e:
                logger.warning(f"Failed to refresh SearXNG instances from searx.space: {e}")
                if disk and disk.get("instances"):
                    logger.info("Falling back to stale on-disk SearXNG instances cache")
                    cls._instances_cache = disk["instances"]
                    cls._instances_fetched_at = disk.get("fetched_at", 0)
                    return cls._instances_cache
                cls._instances_cache = list(SEARXNG_FALLBACK_STATIC)
                cls._instances_fetched_at = 0.0  # не считается свежим — попробуем обновить в след. раз
                return cls._instances_cache

    async def _search_searxng(self, query: str) -> List[Dict]:
        """Опрашивает живые (заранее проверенные на JSON) инстансы SearXNG
        по очереди, пока один из них не даст непустой результат."""
        instances = await self._get_working_instances()
        params = {
            "q": query,
            "format": "json",
            "language": "ru",
            "categories": "general",
        }
        last_exc = None
        async with aiohttp.ClientSession() as session:
            for instance in instances:
                try:
                    async with session.get(
                        f"{instance}/search",
                        params=params,
                        headers=self.headers,
                        timeout=aiohttp.ClientTimeout(total=8),
                    ) as resp:
                        if resp.status != 200:
                            last_exc = Exception(f"HTTP {resp.status} from {instance}")
                            continue
                        ctype = resp.headers.get("Content-Type", "")
                        if "json" not in ctype.lower():
                            # Инстанс перестал отдавать JSON с момента проверки
                            # (сменил настройки) — пропускаем, не считаем за успех.
                            last_exc = Exception(f"Non-JSON content-type from {instance}: {ctype}")
                            continue
                        data = await resp.json(content_type=None)
                        raw_results = data.get("results", [])
                        if not raw_results:
                            continue
                        return [
                            {
                                "title": html.unescape(r.get("title", ""))[:120],
                                "url": r.get("url", ""),
                                "snippet": html.unescape(r.get("content") or "")[:300],
                            }
                            for r in raw_results[:8]
                        ]
                except Exception as e:
                    last_exc = e
                    continue
        if last_exc:
            logger.info(f"All SearXNG instances failed, last error: {last_exc}")
        return []

    async def _search_instant_answer(self, query: str) -> List[Dict]:
        params = {"q": query, "format": "json", "no_html": "1", "no_redirect": "1", "skip_disambig": "1"}
        async with aiohttp.ClientSession() as session:
            async with session.get(
                self.ia_url, params=params, headers=self.headers,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json(content_type=None)

        results: List[Dict] = []

        abstract = (data.get("AbstractText") or "").strip()
        if abstract:
            results.append({
                "title": data.get("Heading") or query,
                "url": data.get("AbstractURL", ""),
                "snippet": abstract,
            })

        def _walk_related(items):
            for item in items:
                if "Topics" in item:
                    _walk_related(item["Topics"])
                elif item.get("Text"):
                    results.append({
                        "title": item.get("Text", "")[:80],
                        "url": item.get("FirstURL", ""),
                        "snippet": item.get("Text", ""),
                    })

        _walk_related(data.get("RelatedTopics", []))

        for ans_key in ("Answer",):
            val = (data.get(ans_key) or "").strip()
            if val:
                results.insert(0, {"title": query, "url": data.get("AbstractURL", ""), "snippet": val})

        return results[:8]

    async def _search_html(self, query: str, retries: int = 1) -> List[Dict]:
        last_exc = None
        for ddg_url in self.ddg_urls:
            for attempt in range(retries + 1):
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.post(
                            ddg_url,
                            data={"q": query, "kl": "ru-ru"},
                            headers=self.headers,
                            timeout=aiohttp.ClientTimeout(total=15)
                        ) as resp:
                            if resp.status != 200:
                                last_exc = Exception(f"HTTP {resp.status} from {ddg_url}")
                                await asyncio.sleep(0.6 * (attempt + 1))
                                continue
                            html_text = await resp.text()
                            results = self._parse_results(html_text)
                            if results:
                                return results
                except Exception as e:
                    last_exc = e
                    await asyncio.sleep(0.6 * (attempt + 1))
        if last_exc:
            raise last_exc
        return []

    @staticmethod
    def _unwrap_ddg_redirect(url: str) -> str:
        """DDG отдаёт ссылки вида //duckduckgo.com/l/?uddg=<encoded-real-url>&...
        Модели и пользователю нужен реальный адрес, а не редирект-обёртка."""
        try:
            if "uddg=" in url:
                parsed = urllib.parse.urlparse(url if "://" in url else f"https:{url}")
                qs = urllib.parse.parse_qs(parsed.query)
                real = qs.get("uddg", [None])[0]
                if real:
                    return urllib.parse.unquote(real)
        except Exception:
            pass
        return url

    @staticmethod
    def _clean_fragment(raw: str) -> str:
        """Снимает вложенные теги (DDG подсвечивает совпадения через <b>)
        и декодирует HTML-сущности — без этого title/snippet с подсветкой
        не матчились вовсе и результат тихо терялся."""
        no_tags = re.sub(r'<[^>]+>', '', raw)
        return html.unescape(no_tags).strip()

    def _parse_results(self, html_text: str) -> List[Dict]:
        results = []
        # Основной паттерн — допускаем вложенные теги (напр. <b>) внутри
        # title/snippet через нежадный [\s\S]*?, а не [^<]+, который ломался
        # на любой подсветке совпадений в разметке DDG.
        result_blocks = re.findall(
            r'<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)</a>.*?'
            r'<a class="result__snippet"[^>]*>([\s\S]*?)</a>',
            html_text, re.DOTALL | re.IGNORECASE
        )
        # Fallback паттерн
        if not result_blocks:
            result_blocks = re.findall(
                r'<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>.*?'
                r'<div class="result__snippet"[^>]*>([\s\S]*?)</div>',
                html_text, re.DOTALL | re.IGNORECASE
            )
        # Если всё равно пусто — попробуем другой вариант
        if not result_blocks:
            result_blocks = re.findall(
                r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>.*?'
                r'<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)</div>',
                html_text, re.DOTALL | re.IGNORECASE
            )
        # Паттерн для lite.duckduckgo.com (табличная разметка, без result__snippet)
        if not result_blocks:
            link_matches = re.findall(
                r'<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>',
                html_text, re.IGNORECASE
            )
            snippet_matches = re.findall(
                r'<td class="result-snippet"[^>]*>([\s\S]*?)</td>',
                html_text, re.DOTALL | re.IGNORECASE
            )
            for i, (url, title) in enumerate(link_matches):
                snippet = snippet_matches[i] if i < len(snippet_matches) else ""
                result_blocks.append((url, title, snippet))
        seen_urls = set()
        for url, title, snippet in result_blocks:
            clean_url = self._unwrap_ddg_redirect(url.strip())
            if clean_url in seen_urls:
                continue
            seen_urls.add(clean_url)
            results.append({
                "title": self._clean_fragment(title),
                "url": clean_url,
                "snippet": self._clean_fragment(snippet),
            })
            if len(results) >= 8:
                break
        return results

    def _format_results(self, results: List[Dict], source: Optional[str] = None) -> str:
        header = f"{SYM['search']} Web Search Results"
        if source:
            header += f" (via {source})"
        lines = [f"{header}:"]
        for i, r in enumerate(results, 1):
            lines.append(f"\n{i}. {r['title']}")
            if r.get('url'):
                lines.append(f"   {SYM['link']} {r['url']}")
            lines.append(f"   {r['snippet'][:200]}")
        return "\n".join(lines)

class FileCreateTool(Tool):
    def __init__(self):
        super().__init__("file_create", "Создание файлов кода и документов", "▤")
        self.files_dir = FILES_DIR

    async def execute(self, query: str, filename: Optional[str] = None, content: Optional[str] = None, **kwargs) -> ToolResult:
        try:
            if not filename:
                fn_match = re.search(r'(?:filename|file|название)[\s:=]+([\w\-\.]+)', query, re.I)
                if fn_match:
                    filename = fn_match.group(1)
                else:
                    ext = kwargs.get("extension", "txt")
                    filename = f"xgo_{uuid.uuid4().hex[:8]}.{ext}"
            filepath = self.files_dir / filename
            if content is None:
                content = query
            filepath.write_text(content, encoding="utf-8")
            return ToolResult(
                self.name, True, f"File created: {filename}",
                {"filepath": str(filepath), "size": len(content)}
            )
        except Exception as e:
            return ToolResult(self.name, False, f"File error: {str(e)}")

class TableRenderTool(Tool):
    # Фиолетовая акцентная палитра
    BG = "#191622"
    PANEL = "#211d2e"
    HEADER_BG = "#3b2a66"
    HEADER_TEXT = "#d9c9ff"
    ROW_A = "#211d2e"
    ROW_B = "#28223a"
    TEXT = "#e8e3f5"
    SUBTEXT = "#a89bc9"
    BORDER = "#4a3d70"
    ACCENT = "#a259ff"
    ACCENT_SOFT = "#7c4dff"
    OK_COLOR = "#4ade80"
    BAD_COLOR = "#f87171"
    WARN_COLOR = "#fbbf24"
    # Системный шрифтовый стек в стиле iOS/macOS: на устройствах Apple SVG
    # отрендерится реальным San Francisco (-apple-system/SF Pro), на остальных
    # платформах браузер аккуратно откатится на Helvetica Neue / Inter / Arial.
    FONT_STACK = (
        "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', "
        "'Helvetica Neue', Inter, Arial, sans-serif"
    )

    def __init__(self):
        super().__init__("table", "Создание красивых таблиц в виде изображений (SVG)", "▦")
        self.files_dir = FILES_DIR

    async def execute(self, query: str, **kwargs) -> ToolResult:
        try:
            headers = kwargs.get("headers", [])
            rows = kwargs.get("rows", [])
            title = kwargs.get("title", "Data Table")
            subtitle = kwargs.get("subtitle", "")
            col_types = kwargs.get("col_types")  # опционально: ["text","check","status","progress"]
            if not headers and not rows:
                parsed = self._parse_markdown_table(query)
                if parsed:
                    headers, rows = parsed
            if not headers:
                return ToolResult(self.name, False, "No table data provided")
            img_path = self._render_table_svg(headers, rows, title, subtitle, col_types)
            return ToolResult(
                self.name, True, f"Table rendered: {img_path.name}",
                {"filepath": str(img_path), "type": "image/svg+xml"}
            )
        except Exception as e:
            return ToolResult(self.name, False, f"Table error: {str(e)}")

    def _parse_markdown_table(self, text: str) -> Optional[Tuple[List[str], List[List[str]]]]:
        lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
        table_lines = [l for l in lines if l.startswith("|")]
        if len(table_lines) < 2:
            return None
        headers = [c.strip() for c in table_lines[0].split("|")[1:-1]]
        rows = []
        for line in table_lines[2:]:
            rows.append([c.strip() for c in line.split("|")[1:-1]])
        return headers, rows

    # ------------------------------------------------------------------
    # Измерение и перенос текста
    # ------------------------------------------------------------------
    @staticmethod
    def _char_width(ch: str, font_size: int) -> float:
        # Грубая, но практичная оценка ширины символа для моноширинного
        # рендеринга без реального шрифтового движка. Кириллица и широкие
        # символы шире латиницы примерно в 1.05-1.15 раза при равной высоте.
        if ch.isupper():
            return font_size * 0.66
        if ord(ch) > 0x400:  # кириллица и другие не-латинские блоки
            return font_size * 0.60
        if ch in "iIl.,:;'!|":
            return font_size * 0.30
        if ch == " ":
            return font_size * 0.30
        return font_size * 0.56

    @classmethod
    def _text_width(cls, text: str, font_size: int) -> float:
        return sum(cls._char_width(c, font_size) for c in text)

    @classmethod
    def _wrap_text(cls, text: str, max_width: float, font_size: int) -> List[str]:
        text = str(text)
        if not text:
            return [""]
        words = text.split(" ")
        lines: List[str] = []
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if cls._text_width(candidate, font_size) <= max_width or not current:
                current = candidate
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)
        # Жёсткий обрыв слишком длинных отдельных слов (URL, длинные ID и т.п.)
        final_lines: List[str] = []
        for line in lines:
            while cls._text_width(line, font_size) > max_width and len(line) > 4:
                cut = max(4, int(len(line) * max_width / max(cls._text_width(line, font_size), 1)))
                final_lines.append(line[:cut])
                line = line[cut:]
            final_lines.append(line)
        return final_lines or [""]

    # ------------------------------------------------------------------
    # Ячейки специального типа: чекбоксы / статус-бейджи / прогресс-бары
    # ------------------------------------------------------------------
    def _cell_kind(self, col_types: Optional[List[str]], col_idx: int, raw_value: str) -> str:
        if col_types and col_idx < len(col_types):
            return col_types[col_idx]
        v = str(raw_value).strip().lower()
        if v in ("true", "false", "yes", "no", "да", "нет", "✓", "✗", "x", "checked", "unchecked"):
            return "check"
        return "text"

    @staticmethod
    def _is_truthy(raw_value: str) -> bool:
        return str(raw_value).strip().lower() in ("true", "yes", "да", "✓", "checked", "1")

    def _render_check_svg(self, x: float, y: float, size: float, checked: bool) -> str:
        cx, cy = x, y
        if checked:
            return (
                f'<rect x="{cx}" y="{cy}" width="{size}" height="{size}" rx="4" '
                f'fill="{self.ACCENT}" stroke="{self.ACCENT_SOFT}" stroke-width="1.5"/>'
                f'<path d="M {cx + size*0.22} {cy + size*0.52} L {cx + size*0.42} {cy + size*0.72} '
                f'L {cx + size*0.78} {cy + size*0.28}" stroke="white" stroke-width="2.4" '
                f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
            )
        return (
            f'<rect x="{cx}" y="{cy}" width="{size}" height="{size}" rx="4" '
            f'fill="none" stroke="{self.SUBTEXT}" stroke-width="1.5"/>'
        )

    def _render_status_badge(self, x: float, y: float, text: str, font_size: int) -> str:
        v = str(text).strip().lower()
        if v in ("ok", "готово", "done", "success", "успех", "активен", "active"):
            color, label = self.OK_COLOR, text
        elif v in ("error", "ошибка", "fail", "failed", "заблокирован", "blocked"):
            color, label = self.BAD_COLOR, text
        elif v in ("warning", "внимание", "pending", "ожидание", "в процессе"):
            color, label = self.WARN_COLOR, text
        else:
            color, label = self.ACCENT, text
        w = self._text_width(label, font_size) + 20
        return (
            f'<rect x="{x}" y="{y}" width="{w}" height="{font_size + 10}" rx="{(font_size + 10) / 2}" '
            f'fill="{color}" opacity="0.18" stroke="{color}" stroke-width="1"/>'
            f'<text x="{x + w/2}" y="{y + font_size + 3}" fill="{color}" font-size="{font_size}" '
            f'font-family="{self.FONT_STACK}" text-anchor="middle" font-weight="600">{html.escape(label)}</text>'
        )

    def _render_progress_bar(self, x: float, y: float, width: float, height: float, value_text: str) -> str:
        try:
            pct = float(str(value_text).strip().rstrip("%"))
            pct = max(0.0, min(100.0, pct))
        except ValueError:
            pct = 0.0
        filled = width * (pct / 100.0)
        return (
            f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{height/2}" fill="{self.PANEL}" stroke="{self.BORDER}" stroke-width="1"/>'
            f'<rect x="{x}" y="{y}" width="{filled}" height="{height}" rx="{height/2}" fill="{self.ACCENT}"/>'
            f'<text x="{x + width + 10}" y="{y + height - 2}" fill="{self.TEXT}" font-size="12" '
            f'font-family="{self.FONT_STACK}">{pct:.0f}%</text>'
        )

    # ------------------------------------------------------------------
    # Основной рендер
    # ------------------------------------------------------------------
    def _render_table_svg(
        self,
        headers: List[str],
        rows: List[List[str]],
        title: str,
        subtitle: str = "",
        col_types: Optional[List[str]] = None,
    ) -> Path:
        font_size = 15
        header_font_size = 15
        title_font_size = 22
        subtitle_font_size = 13
        cell_pad_x = 18
        cell_pad_y = 12
        line_height = font_size + 6
        min_col_width = 110
        max_col_width = 340

        n_cols = len(headers)
        # Ширина колонки: по самому длинному слову/значению в ней, с разумными границами,
        # чтобы контент занимал всё доступное пространство, а не жался в угол.
        col_widths = []
        for i, h in enumerate(headers):
            sample_texts = [h] + [str(r[i]) for r in rows if i < len(r)]
            widest = max((self._text_width(t, font_size) for t in sample_texts), default=min_col_width)
            col_widths.append(max(min_col_width, min(max_col_width, widest + cell_pad_x * 2)))

        # Пересчитываем количество строк-переносов на ячейку, чтобы посчитать высоту строки
        def row_wrapped(row: List[str]) -> List[List[str]]:
            wrapped = []
            for i in range(n_cols):
                raw = str(row[i]) if i < len(row) else ""
                kind = self._cell_kind(col_types, i, raw)
                avail = col_widths[i] - cell_pad_x * 2
                if kind in ("check", "status", "progress"):
                    wrapped.append([raw])  # спец-виджеты не переносятся построчно
                else:
                    wrapped.append(self._wrap_text(raw, avail, font_size))
            return wrapped

        wrapped_rows = [row_wrapped(r) for r in rows]
        row_heights = []
        for wrapped in wrapped_rows:
            max_lines = max((len(c) for c in wrapped), default=1)
            row_heights.append(max(36, max_lines * line_height + cell_pad_y))

        total_width = sum(col_widths) + 2
        title_block_height = 0
        if title:
            title_block_height += title_font_size + 22
        if subtitle:
            title_block_height += subtitle_font_size + 14
        header_height = header_font_size + cell_pad_y * 2
        total_height = title_block_height + header_height + sum(row_heights) + 20

        svg = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="{total_height}" '
            f'viewBox="0 0 {total_width} {total_height}" font-family="{self.FONT_STACK}">',
            f'<rect width="100%" height="100%" fill="{self.BG}"/>',
        ]

        y = 0
        if title:
            svg.append(
                f'<text x="24" y="{y + title_font_size + 8}" fill="{self.ACCENT}" '
                f'font-size="{title_font_size}" font-weight="700">{html.escape(str(title))}</text>'
            )
            y += title_font_size + 16
            svg.append(f'<rect x="24" y="{y}" width="46" height="4" rx="2" fill="{self.ACCENT}"/>')
            y += 12
        if subtitle:
            svg.append(
                f'<text x="24" y="{y + subtitle_font_size + 4}" fill="{self.SUBTEXT}" '
                f'font-size="{subtitle_font_size}">{html.escape(str(subtitle))}</text>'
            )
            y += subtitle_font_size + 14

        table_top = y
        # Заголовок таблицы
        x = 1
        svg.append(f'<rect x="1" y="{y}" width="{total_width - 2}" height="{header_height}" fill="{self.HEADER_BG}"/>')
        for i, h in enumerate(headers):
            svg.append(
                f'<text x="{x + cell_pad_x}" y="{y + header_height/2 + header_font_size/3}" '
                f'fill="{self.HEADER_TEXT}" font-size="{header_font_size}" font-weight="700">{html.escape(str(h))}</text>'
            )
            x += col_widths[i]
            if i < n_cols - 1:
                svg.append(f'<line x1="{x}" y1="{y}" x2="{x}" y2="{y + header_height}" stroke="{self.BORDER}" stroke-width="1" opacity="0.6"/>')
        y += header_height

        # Строки данных
        for row_idx, (row, wrapped) in enumerate(zip(rows, wrapped_rows)):
            rh = row_heights[row_idx]
            row_color = self.ROW_A if row_idx % 2 == 0 else self.ROW_B
            svg.append(f'<rect x="1" y="{y}" width="{total_width - 2}" height="{rh}" fill="{row_color}"/>')
            x = 1
            for i in range(n_cols):
                raw = str(row[i]) if i < len(row) else ""
                kind = self._cell_kind(col_types, i, raw)
                cx = x + cell_pad_x
                cy = y + cell_pad_y / 2
                if kind == "check":
                    box_size = min(22, rh - 10)
                    svg.append(self._render_check_svg(cx, y + (rh - box_size) / 2, box_size, self._is_truthy(raw)))
                elif kind == "status":
                    svg.append(self._render_status_badge(cx, y + (rh - (font_size + 10)) / 2, raw, font_size - 1))
                elif kind == "progress":
                    bar_w = min(140, col_widths[i] - cell_pad_x * 2 - 40)
                    svg.append(self._render_progress_bar(cx, y + (rh - 10) / 2, max(40, bar_w), 10, raw))
                else:
                    for line_idx, line in enumerate(wrapped[i]):
                        ly = y + cell_pad_y / 2 + (line_idx + 1) * line_height - 4
                        svg.append(
                            f'<text x="{cx}" y="{ly}" fill="{self.TEXT}" font-size="{font_size}">{html.escape(line)}</text>'
                        )
                x += col_widths[i]
                if i < n_cols - 1:
                    svg.append(f'<line x1="{x}" y1="{y}" x2="{x}" y2="{y + rh}" stroke="{self.BORDER}" stroke-width="1" opacity="0.35"/>')
            y += rh

        # Внешняя рамка с фиолетовым акцентом
        svg.append(
            f'<rect x="1" y="{table_top}" width="{total_width - 2}" height="{y - table_top}" '
            f'fill="none" stroke="{self.BORDER}" stroke-width="1.5"/>'
        )
        svg.append(
            f'<rect x="0" y="0" width="{total_width}" height="{total_height}" '
            f'fill="none" stroke="{self.ACCENT_SOFT}" stroke-width="2" opacity="0.5"/>'
        )
        svg.append("</svg>")

        filepath = self.files_dir / f"table_{uuid.uuid4().hex[:8]}.svg"
        filepath.write_text("\n".join(svg), encoding="utf-8")
        return filepath

class ChartRenderTool(Tool):
    """Диаграммы в фирменной фиолетовой палитре: bar/line/pie/radar/scatter —
    для сравнения значений, динамики во времени, долей и многомерных
    сравнений соответственно."""
    BG = "#191622"
    PANEL = "#211d2e"
    TEXT = "#e8e3f5"
    SUBTEXT = "#a89bc9"
    BORDER = "#4a3d70"
    ACCENT = "#a259ff"
    ACCENT_SOFT = "#7c4dff"
    BAR_COLORS = ["#a259ff", "#7c4dff", "#c084fc", "#9333ea", "#d8b4fe", "#6d28d9"]
    FONT_STACK = (
        "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', "
        "'Helvetica Neue', Inter, Arial, sans-serif"
    )

    def __init__(self):
        super().__init__("chart", "Создание диаграмм: bar/line/pie/radar/scatter", "▦")
        self.files_dir = FILES_DIR

    async def execute(self, query: str, **kwargs) -> ToolResult:
        chart_type = str(kwargs.get("type", "bar")).lower().strip()
        try:
            title = kwargs.get("title", "Chart")
            subtitle = kwargs.get("subtitle", "")
            unit = kwargs.get("unit", "")

            if chart_type == "line":
                series = self._normalize_series(kwargs)
                labels = kwargs.get("labels", [])
                if not labels or not series:
                    return ToolResult(self.name, False, "labels and values (or series) are required")
                img_path = self._render_line_chart(labels, series, title, subtitle, unit)
            elif chart_type in ("pie", "donut"):
                labels = kwargs.get("labels", [])
                values = self._to_numeric(kwargs.get("values", []))
                if not labels or not values or len(labels) != len(values):
                    return ToolResult(self.name, False, "labels and values are required and must be the same length")
                img_path = self._render_pie_chart(labels, values, title, subtitle, donut=(chart_type == "donut"))
            elif chart_type == "radar":
                series = self._normalize_series(kwargs)
                labels = kwargs.get("labels", [])
                if not labels or not series:
                    return ToolResult(self.name, False, "labels (axes) and values (or series) are required")
                img_path = self._render_radar_chart(labels, series, title, subtitle)
            elif chart_type == "scatter":
                points = kwargs.get("points", [])
                if not points:
                    return ToolResult(self.name, False, "points ([{\"x\":.., \"y\":.., \"label\":..}, ...]) is required")
                img_path = self._render_scatter_chart(points, title, subtitle, unit)
            else:
                labels = kwargs.get("labels", [])
                values = self._to_numeric(kwargs.get("values", []))
                if not labels or not values or len(labels) != len(values):
                    return ToolResult(self.name, False, "labels and values are required and must be the same length")
                img_path = self._render_bar_chart(labels, values, title, subtitle, unit)

            return ToolResult(
                self.name, True, f"Chart rendered: {img_path.name}",
                {"filepath": str(img_path), "type": "image/svg+xml"}
            )
        except Exception as e:
            return ToolResult(self.name, False, f"Chart error: {str(e)}")

    @staticmethod
    def _to_numeric(values: list) -> List[float]:
        out = []
        for v in values:
            try:
                out.append(float(v))
            except (TypeError, ValueError):
                out.append(0.0)
        return out

    @classmethod
    def _normalize_series(cls, kwargs: dict) -> List[Dict]:
        """Приводит вход к единому виду [{"name":.., "values":[...]}, ...] --
        принимает и одиночный values=[...], и явный multi-series."""
        raw_series = kwargs.get("series")
        if raw_series:
            out = []
            for s in raw_series:
                out.append({"name": s.get("name", ""), "values": cls._to_numeric(s.get("values", []))})
            return out
        values = kwargs.get("values")
        if values:
            return [{"name": kwargs.get("series_name", ""), "values": cls._to_numeric(values)}]
        return []

    @staticmethod
    def _char_width(ch: str, font_size: int) -> float:
        if ord(ch) > 0x400:
            return font_size * 0.60
        return font_size * 0.56

    @classmethod
    def _text_width(cls, text: str, font_size: int) -> float:
        return sum(cls._char_width(c, font_size) for c in str(text))

    def _svg_header(self, width: float, height: float) -> List[str]:
        return [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}" font-family="{self.FONT_STACK}">',
            f'<rect width="100%" height="100%" fill="{self.BG}"/>',
        ]

    def _title_block(self, svg: List[str], total_width: float, title: str, subtitle: str) -> float:
        title_font_size, subtitle_font_size = 22, 13
        y = 0
        if title:
            svg.append(
                f'<text x="24" y="{y + title_font_size + 8}" fill="{self.ACCENT}" '
                f'font-size="{title_font_size}" font-weight="700">{html.escape(str(title))}</text>'
            )
            y += title_font_size + 16
            svg.append(f'<rect x="24" y="{y}" width="46" height="4" rx="2" fill="{self.ACCENT}"/>')
            y += 12
        if subtitle:
            svg.append(
                f'<text x="24" y="{y + subtitle_font_size + 4}" fill="{self.SUBTEXT}" '
                f'font-size="{subtitle_font_size}">{html.escape(str(subtitle))}</text>'
            )
            y += subtitle_font_size + 14
        return y

    def _save(self, svg: List[str]) -> Path:
        svg.append("</svg>")
        filepath = self.files_dir / f"chart_{uuid.uuid4().hex[:8]}.svg"
        filepath.write_text("\n".join(svg), encoding="utf-8")
        return filepath

    def _render_bar_chart(
        self, labels: List[str], values: List[float], title: str, subtitle: str, unit: str
    ) -> Path:
        font_size = 13
        label_font_size = 13
        bar_gap = 24
        bar_width = 64
        chart_height = 320
        left_pad = 60
        right_pad = 40
        top_pad = 30

        n = len(values)
        max_val = max(values) if values else 1.0
        max_val = max_val if max_val > 0 else 1.0

        chart_area_width = n * bar_width + (n - 1) * bar_gap if n > 0 else bar_width
        total_width = left_pad + chart_area_width + right_pad
        label_block_height = 60

        svg = self._svg_header(1, 1)  # placeholder, real size set after computing title height
        title_h = self._title_block(svg, total_width, title, subtitle)
        total_height = title_h + top_pad + chart_height + label_block_height + 40
        svg[0] = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="{total_height}" '
            f'viewBox="0 0 {total_width} {total_height}" font-family="{self.FONT_STACK}">'
        )

        chart_top = title_h + top_pad
        baseline = chart_top + chart_height

        for frac in (0.0, 0.25, 0.5, 0.75, 1.0):
            gy = baseline - chart_height * frac
            svg.append(f'<line x1="{left_pad - 10}" y1="{gy}" x2="{total_width - right_pad + 10}" y2="{gy}" '
                        f'stroke="{self.BORDER}" stroke-width="1" opacity="0.35"/>')
            val_label = f"{max_val * frac:.0f}{unit}"
            svg.append(f'<text x="{left_pad - 16}" y="{gy + 4}" fill="{self.SUBTEXT}" font-size="11" text-anchor="end">{html.escape(val_label)}</text>')

        x = left_pad
        for i, (label, val) in enumerate(zip(labels, values)):
            bar_h = chart_height * (val / max_val)
            by = baseline - bar_h
            color = self.BAR_COLORS[i % len(self.BAR_COLORS)]
            svg.append(f'<rect x="{x}" y="{by}" width="{bar_width}" height="{bar_h}" rx="6" fill="{color}"/>')
            val_text = f"{val:g}{unit}"
            svg.append(
                f'<text x="{x + bar_width/2}" y="{by - 8}" fill="{self.TEXT}" font-size="{font_size}" '
                f'text-anchor="middle" font-weight="600">{html.escape(val_text)}</text>'
            )
            label_str = str(label)
            max_label_width = bar_width + bar_gap - 6
            if self._text_width(label_str, label_font_size) > max_label_width and " " in label_str:
                words = label_str.split(" ")
                mid = len(words) // 2 or 1
                lines = [" ".join(words[:mid]), " ".join(words[mid:])]
            else:
                lines = [label_str]
            for li, line in enumerate(lines):
                svg.append(
                    f'<text x="{x + bar_width/2}" y="{baseline + 20 + li * (label_font_size + 4)}" '
                    f'fill="{self.SUBTEXT}" font-size="{label_font_size}" text-anchor="middle">{html.escape(line)}</text>'
                )
            x += bar_width + bar_gap

        svg.append(f'<line x1="{left_pad - 10}" y1="{baseline}" x2="{total_width - right_pad + 10}" y2="{baseline}" '
                    f'stroke="{self.ACCENT_SOFT}" stroke-width="2"/>')
        svg.append(f'<rect x="0" y="0" width="{total_width}" height="{total_height}" '
                    f'fill="none" stroke="{self.ACCENT_SOFT}" stroke-width="2" opacity="0.5"/>')
        return self._save(svg)

    def _render_line_chart(
        self, labels: List[str], series: List[Dict], title: str, subtitle: str, unit: str
    ) -> Path:
        left_pad, right_pad, top_pad, bottom_pad = 60, 40, 30, 60
        chart_height = 320
        n = len(labels)
        step = max((760 // max(n - 1, 1)), 60)
        chart_width = step * max(n - 1, 1)
        total_width = left_pad + chart_width + right_pad

        all_vals = [v for s in series for v in s["values"]]
        max_val = max(all_vals) if all_vals else 1.0
        min_val = min(0.0, min(all_vals) if all_vals else 0.0)
        max_val = max_val if max_val > min_val else min_val + 1.0
        val_range = max_val - min_val

        svg = self._svg_header(1, 1)
        title_h = self._title_block(svg, total_width, title, subtitle)
        total_height = title_h + top_pad + chart_height + bottom_pad
        svg[0] = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="{total_height}" '
            f'viewBox="0 0 {total_width} {total_height}" font-family="{self.FONT_STACK}">'
        )
        chart_top = title_h + top_pad
        baseline = chart_top + chart_height

        for frac in (0.0, 0.25, 0.5, 0.75, 1.0):
            gy = baseline - chart_height * frac
            svg.append(f'<line x1="{left_pad - 10}" y1="{gy}" x2="{total_width - right_pad + 10}" y2="{gy}" '
                        f'stroke="{self.BORDER}" stroke-width="1" opacity="0.35"/>')
            val_label = f"{min_val + val_range * frac:.0f}{unit}"
            svg.append(f'<text x="{left_pad - 16}" y="{gy + 4}" fill="{self.SUBTEXT}" font-size="11" text-anchor="end">{html.escape(val_label)}</text>')

        for i, label in enumerate(labels):
            lx = left_pad + i * step
            svg.append(f'<text x="{lx}" y="{baseline + 22}" fill="{self.SUBTEXT}" font-size="12" text-anchor="middle">{html.escape(str(label))}</text>')

        for si, s in enumerate(series):
            color = self.BAR_COLORS[si % len(self.BAR_COLORS)]
            pts = []
            for i, v in enumerate(s["values"][:n]):
                px = left_pad + i * step
                py = baseline - chart_height * ((v - min_val) / val_range)
                pts.append((px, py))
            if len(pts) > 1:
                path = " ".join(f"{'M' if i == 0 else 'L'}{px:.1f},{py:.1f}" for i, (px, py) in enumerate(pts))
                svg.append(f'<path d="{path}" fill="none" stroke="{color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>')
            for px, py in pts:
                svg.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="4" fill="{color}"/>')
            if s.get("name"):
                svg.append(
                    f'<rect x="{left_pad + si * 150}" y="{title_h + 4}" width="10" height="10" rx="2" fill="{color}"/>'
                    f'<text x="{left_pad + si * 150 + 16}" y="{title_h + 13}" fill="{self.SUBTEXT}" font-size="12">{html.escape(s["name"])}</text>'
                )

        svg.append(f'<line x1="{left_pad - 10}" y1="{baseline}" x2="{total_width - right_pad + 10}" y2="{baseline}" '
                    f'stroke="{self.ACCENT_SOFT}" stroke-width="2"/>')
        svg.append(f'<rect x="0" y="0" width="{total_width}" height="{total_height}" '
                    f'fill="none" stroke="{self.ACCENT_SOFT}" stroke-width="2" opacity="0.5"/>')
        return self._save(svg)

    def _render_pie_chart(
        self, labels: List[str], values: List[float], title: str, subtitle: str, donut: bool
    ) -> Path:
        total_width = 560
        cx, cy, r = 200, 0, 140  # cy устанавливается ниже после расчёта заголовка
        legend_x = 400

        svg = self._svg_header(1, 1)
        title_h = self._title_block(svg, total_width, title, subtitle)
        total_height = max(title_h + 40 + r * 2, title_h + 30 + len(labels) * 26)
        svg[0] = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="{total_height}" '
            f'viewBox="0 0 {total_width} {total_height}" font-family="{self.FONT_STACK}">'
        )
        cy = title_h + 40 + r

        total = sum(values) or 1.0
        start_angle = -90.0
        import math as _math
        for i, (label, val) in enumerate(zip(labels, values)):
            frac = val / total
            end_angle = start_angle + frac * 360.0
            color = self.BAR_COLORS[i % len(self.BAR_COLORS)]
            large_arc = 1 if (end_angle - start_angle) > 180 else 0
            x1 = cx + r * _math.cos(_math.radians(start_angle))
            y1 = cy + r * _math.sin(_math.radians(start_angle))
            x2 = cx + r * _math.cos(_math.radians(end_angle))
            y2 = cy + r * _math.sin(_math.radians(end_angle))
            svg.append(
                f'<path d="M{cx},{cy} L{x1:.2f},{y1:.2f} A{r},{r} 0 {large_arc} 1 {x2:.2f},{y2:.2f} Z" '
                f'fill="{color}" stroke="{self.BG}" stroke-width="2"/>'
            )
            svg.append(
                f'<rect x="{legend_x}" y="{cy - r + i * 26}" width="12" height="12" rx="3" fill="{color}"/>'
                f'<text x="{legend_x + 18}" y="{cy - r + i * 26 + 11}" fill="{self.TEXT}" font-size="13">'
                f'{html.escape(str(label))} — {frac*100:.1f}%</text>'
            )
            start_angle = end_angle
        if donut:
            svg.append(f'<circle cx="{cx}" cy="{cy}" r="{r*0.55}" fill="{self.BG}"/>')
        return self._save(svg)

    def _render_radar_chart(
        self, labels: List[str], series: List[Dict], title: str, subtitle: str
    ) -> Path:
        import math as _math
        total_width, r = 520, 170
        n_axes = len(labels)
        svg = self._svg_header(1, 1)
        title_h = self._title_block(svg, total_width, title, subtitle)
        total_height = title_h + 60 + r * 2
        svg[0] = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="{total_height}" '
            f'viewBox="0 0 {total_width} {total_height}" font-family="{self.FONT_STACK}">'
        )
        cx, cy = total_width / 2, title_h + 30 + r

        all_vals = [v for s in series for v in s["values"]]
        max_val = max(all_vals) if all_vals else 1.0
        max_val = max_val if max_val > 0 else 1.0

        def point(i, frac):
            angle = -90 + (360 / n_axes) * i
            rad = _math.radians(angle)
            return cx + r * frac * _math.cos(rad), cy + r * frac * _math.sin(rad)

        for ring in (0.25, 0.5, 0.75, 1.0):
            pts = [point(i, ring) for i in range(n_axes)]
            path = " ".join(f"{'M' if i == 0 else 'L'}{px:.1f},{py:.1f}" for i, (px, py) in enumerate(pts)) + " Z"
            svg.append(f'<path d="{path}" fill="none" stroke="{self.BORDER}" stroke-width="1" opacity="0.4"/>')

        for i, label in enumerate(labels):
            lx, ly = point(i, 1.16)
            svg.append(f'<text x="{lx:.1f}" y="{ly:.1f}" fill="{self.SUBTEXT}" font-size="12" text-anchor="middle">{html.escape(str(label))}</text>')

        for si, s in enumerate(series):
            color = self.BAR_COLORS[si % len(self.BAR_COLORS)]
            pts = [point(i, (v / max_val)) for i, v in enumerate(s["values"][:n_axes])]
            path = " ".join(f"{'M' if i == 0 else 'L'}{px:.1f},{py:.1f}" for i, (px, py) in enumerate(pts)) + " Z"
            svg.append(f'<path d="{path}" fill="{color}" fill-opacity="0.22" stroke="{color}" stroke-width="2"/>')
            if s.get("name"):
                svg.append(
                    f'<rect x="24" y="{title_h + 4 + si * 18}" width="10" height="10" rx="2" fill="{color}"/>'
                    f'<text x="40" y="{title_h + 13 + si * 18}" fill="{self.SUBTEXT}" font-size="12">{html.escape(s["name"])}</text>'
                )
        return self._save(svg)

    def _render_scatter_chart(
        self, points: List[Dict], title: str, subtitle: str, unit: str
    ) -> Path:
        left_pad, right_pad, top_pad, bottom_pad = 60, 40, 30, 50
        chart_w, chart_h = 480, 320
        total_width = left_pad + chart_w + right_pad

        xs = [self._to_numeric([p.get("x", 0)])[0] for p in points]
        ys = [self._to_numeric([p.get("y", 0)])[0] for p in points]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        if x_max == x_min:
            x_max += 1
        if y_max == y_min:
            y_max += 1

        svg = self._svg_header(1, 1)
        title_h = self._title_block(svg, total_width, title, subtitle)
        total_height = title_h + top_pad + chart_h + bottom_pad
        svg[0] = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="{total_height}" '
            f'viewBox="0 0 {total_width} {total_height}" font-family="{self.FONT_STACK}">'
        )
        chart_top = title_h + top_pad
        baseline = chart_top + chart_h

        for frac in (0.0, 0.25, 0.5, 0.75, 1.0):
            gy = baseline - chart_h * frac
            svg.append(f'<line x1="{left_pad - 10}" y1="{gy}" x2="{total_width - right_pad + 10}" y2="{gy}" '
                        f'stroke="{self.BORDER}" stroke-width="1" opacity="0.35"/>')
            svg.append(f'<text x="{left_pad - 16}" y="{gy + 4}" fill="{self.SUBTEXT}" font-size="11" text-anchor="end">{y_min + (y_max-y_min)*frac:.1f}{unit}</text>')
        for frac in (0.0, 0.25, 0.5, 0.75, 1.0):
            gx = left_pad + chart_w * frac
            svg.append(f'<text x="{gx}" y="{baseline + 20}" fill="{self.SUBTEXT}" font-size="11" text-anchor="middle">{x_min + (x_max-x_min)*frac:.1f}</text>')

        for i, p in enumerate(points):
            px = left_pad + chart_w * ((xs[i] - x_min) / (x_max - x_min))
            py = baseline - chart_h * ((ys[i] - y_min) / (y_max - y_min))
            color = self.BAR_COLORS[i % len(self.BAR_COLORS)]
            svg.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="6" fill="{color}" fill-opacity="0.85" stroke="{self.BG}" stroke-width="1.5"/>')
            if p.get("label"):
                svg.append(f'<text x="{px:.1f}" y="{py-10:.1f}" fill="{self.SUBTEXT}" font-size="11" text-anchor="middle">{html.escape(str(p["label"]))}</text>')

        svg.append(f'<line x1="{left_pad - 10}" y1="{baseline}" x2="{total_width - right_pad + 10}" y2="{baseline}" stroke="{self.ACCENT_SOFT}" stroke-width="2"/>')
        svg.append(f'<line x1="{left_pad - 10}" y1="{chart_top - 10}" x2="{left_pad - 10}" y2="{baseline}" stroke="{self.ACCENT_SOFT}" stroke-width="2"/>')
        svg.append(f'<rect x="0" y="0" width="{total_width}" height="{total_height}" fill="none" stroke="{self.ACCENT_SOFT}" stroke-width="2" opacity="0.5"/>')
        return self._save(svg)

class GraphViewTool(Tool):
    """Граф связей между узлами в стиле Obsidian Graph View: сам вычисляет
    раскладку (force-directed — узлы отталкиваются, связанные притягиваются,
    получается «паутина», а не жёсткая сетка) и рендерит в SVG в фирменной
    палитре. Принимает либо явные nodes/edges, либо готовый markdown-текст
    с [[wiki-ссылками]] и #тегами (как в Obsidian/Obsidian-совместимых
    заметках) — тогда сам парсит связи и тегами красит узлы по кластерам."""
    BG = "#191622"
    TEXT = "#e8e3f5"
    SUBTEXT = "#a89bc9"
    ACCENT = "#a259ff"
    ACCENT_SOFT = "#7c4dff"
    GHOST = "#4a4e5e"
    GROUP_COLORS = ["#a259ff", "#22d3ee", "#f472b6", "#fbbf24", "#34d399", "#818cf8", "#f87171", "#c084fc"]
    FONT_STACK = (
        "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', "
        "'Helvetica Neue', Inter, Arial, sans-serif"
    )

    def __init__(self):
        super().__init__("graph", "Граф связей узлов (сеть, карта заметок, дерево ссылок) в стиле Obsidian", "◈")
        self.files_dir = FILES_DIR

    async def execute(self, query: str, **kwargs) -> ToolResult:
        try:
            markdown_text = kwargs.get("markdown")
            title = kwargs.get("title", "Граф связей")
            directed = bool(kwargs.get("directed", False))

            if markdown_text:
                nodes, edges = self._parse_markdown(str(markdown_text))
            else:
                raw_nodes = kwargs.get("nodes", [])
                raw_edges = kwargs.get("edges", [])
                nodes = []
                for n in raw_nodes:
                    if isinstance(n, dict):
                        nid = str(n.get("id", n.get("label", "")))
                        nodes.append({"id": nid, "label": str(n.get("label", nid)), "group": str(n.get("group", ""))})
                    else:
                        nodes.append({"id": str(n), "label": str(n), "group": ""})
                edges = []
                for e in raw_edges:
                    if isinstance(e, dict):
                        edges.append((str(e.get("source", "")), str(e.get("target", ""))))
                    elif isinstance(e, (list, tuple)) and len(e) == 2:
                        edges.append((str(e[0]), str(e[1])))

            if not nodes:
                return ToolResult(self.name, False, "nodes (or markdown with headings/links) is required")

            layout = self._layout(nodes, edges)
            img_path = self._render(nodes, edges, layout, title, directed)
            return ToolResult(
                self.name, True, f"Graph rendered: {img_path.name} ({len(nodes)} nodes, {len(edges)} edges)",
                {"filepath": str(img_path), "type": "image/svg+xml"}
            )
        except Exception as e:
            return ToolResult(self.name, False, f"Graph error: {str(e)}")

    @staticmethod
    def _parse_markdown(text: str) -> Tuple[List[Dict], List[Tuple[str, str]]]:
        """Заметки = блоки, начинающиеся с '# Заголовок'. [[Ссылки]] внутри
        тела заметки становятся рёбрами; #теги красят узел в свою группу.
        Ссылка на несуществующую заметку создаёт «призрачный» узел --
        как нерешённые (unresolved) ссылки в Obsidian."""
        blocks = re.split(r'\n(?=#{1,6}\s+)', text.strip())
        note_bodies: Dict[str, str] = {}
        for block in blocks:
            block = block.strip()
            if not block:
                continue
            lines = block.split('\n')
            title = re.sub(r'^#{1,6}\s*', '', lines[0]).strip()
            if not title:
                continue
            note_bodies[title] = '\n'.join(lines[1:])

        link_re = re.compile(r'\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]')
        tag_re = re.compile(r'#([\w\-А-Яа-яЁё]+)')

        nodes: Dict[str, Dict] = {}
        for title, body in note_bodies.items():
            tags = tag_re.findall(body)
            nodes[title] = {"id": title, "label": title, "group": tags[0] if tags else ""}

        edges: List[Tuple[str, str]] = []
        for title, body in note_bodies.items():
            for m in link_re.finditer(body):
                target = m.group(1).strip()
                if not target or target == title:
                    continue
                if target not in nodes:
                    nodes[target] = {"id": target, "label": target, "group": "__ghost__"}
                edges.append((title, target))

        return list(nodes.values()), edges

    @staticmethod
    def _layout(nodes: List[Dict], edges: List[Tuple[str, str]], width: float = 760, height: float = 560, iterations: int = 220):
        """Простой force-directed (Fruchterman-Reingold) в чистом Python:
        все узлы взаимно отталкиваются, связанные — дополнительно
        притягиваются, температура со временем остывает. Раскладка каждый
        раз детерминирована (fixed seed), чтобы одинаковый вход давал
        одинаковую картинку."""
        n = len(nodes)
        ids = [node["id"] for node in nodes]
        if n == 0:
            return {}, width, height
        rnd = random.Random(42)
        pos = {i: [rnd.uniform(width * 0.35, width * 0.65), rnd.uniform(height * 0.35, height * 0.65)] for i in ids}
        if n == 1:
            pos[ids[0]] = [width / 2, height / 2]
            return pos, width, height

        k = math.sqrt((width * height) / n) * 0.9
        valid_edges = [(a, b) for a, b in edges if a in pos and b in pos]

        for it in range(iterations):
            disp = {i: [0.0, 0.0] for i in ids}
            for i in range(n):
                for j in range(i + 1, n):
                    a, b = ids[i], ids[j]
                    dx = pos[a][0] - pos[b][0]
                    dy = pos[a][1] - pos[b][1]
                    dist = math.hypot(dx, dy) or 0.01
                    force = (k * k) / dist
                    fx, fy = dx / dist * force, dy / dist * force
                    disp[a][0] += fx; disp[a][1] += fy
                    disp[b][0] -= fx; disp[b][1] -= fy
            for a, b in valid_edges:
                dx = pos[a][0] - pos[b][0]
                dy = pos[a][1] - pos[b][1]
                dist = math.hypot(dx, dy) or 0.01
                force = (dist * dist) / k
                fx, fy = dx / dist * force, dy / dist * force
                disp[a][0] -= fx; disp[a][1] -= fy
                disp[b][0] += fx; disp[b][1] += fy
            temp = width * 0.1 * (1 - it / iterations)
            for i in ids:
                dx, dy = disp[i]
                dist = math.hypot(dx, dy) or 0.01
                pos[i][0] += (dx / dist) * min(dist, temp)
                pos[i][1] += (dy / dist) * min(dist, temp)
                pos[i][0] = min(width - 40, max(40, pos[i][0]))
                pos[i][1] = min(height - 40, max(40, pos[i][1]))
        return pos, width, height

    def _render(self, nodes: List[Dict], edges: List[Tuple[str, str]], layout, title: str, directed: bool) -> Path:
        pos, width, height = layout
        top_pad = 66
        total_width, total_height = width, height + top_pad

        svg = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="{total_height}" '
            f'viewBox="0 0 {total_width} {total_height}" font-family="{self.FONT_STACK}">',
            f'<rect width="100%" height="100%" fill="{self.BG}"/>',
        ]
        if title:
            svg.append(f'<text x="24" y="32" fill="{self.ACCENT}" font-size="20" font-weight="700">{html.escape(str(title))}</text>')
            svg.append(f'<rect x="24" y="42" width="46" height="4" rx="2" fill="{self.ACCENT}"/>')
        if directed:
            svg.append(
                f'<defs><marker id="graphArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" '
                f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{self.ACCENT_SOFT}"/></marker></defs>'
            )

        degree = {node["id"]: 0 for node in nodes}
        for a, b in edges:
            if a in degree: degree[a] += 1
            if b in degree: degree[b] += 1

        group_colors: Dict[str, str] = {}
        gi = 0
        for node in nodes:
            group = node.get("group") or ""
            if group == "__ghost__" or group in group_colors:
                continue
            group_colors[group] = self.GROUP_COLORS[gi % len(self.GROUP_COLORS)]
            gi += 1

        # Рёбра — под узлами
        for a, b in edges:
            if a not in pos or b not in pos:
                continue
            x1, y1 = pos[a][0], pos[a][1] + top_pad
            x2, y2 = pos[b][0], pos[b][1] + top_pad
            marker = ' marker-end="url(#graphArrow)"' if directed else ''
            svg.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                f'stroke="{self.ACCENT_SOFT}" stroke-width="1.3" opacity="0.4"{marker}/>'
            )

        # Узлы поверх рёбер, размер — по числу связей
        for node in nodes:
            nid = node["id"]
            if nid not in pos:
                continue
            x, y = pos[nid][0], pos[nid][1] + top_pad
            r = 7 + min(degree.get(nid, 0), 10) * 1.5
            is_ghost = node.get("group") == "__ghost__"
            color = self.GHOST if is_ghost else group_colors.get(node.get("group") or "", self.ACCENT)
            dash = ' stroke-dasharray="3,3"' if is_ghost else ''
            fill_opacity = "0.3" if is_ghost else "0.92"
            svg.append(
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{color}" fill-opacity="{fill_opacity}" '
                f'stroke="{color}" stroke-width="1.5"{dash}/>'
            )
            label = str(node.get("label", nid))
            text_color = self.SUBTEXT if is_ghost else self.TEXT
            svg.append(
                f'<text x="{x:.1f}" y="{y + r + 14:.1f}" fill="{text_color}" font-size="11" '
                f'text-anchor="middle">{html.escape(label)}</text>'
            )

        # Легенда по группам/тегам
        if group_colors:
            lx, ly = total_width - 170, 24
            for group, color in list(group_colors.items())[:8]:
                if not group:
                    continue
                svg.append(f'<rect x="{lx}" y="{ly}" width="10" height="10" rx="2" fill="{color}"/>')
                svg.append(f'<text x="{lx + 16}" y="{ly + 9}" fill="{self.SUBTEXT}" font-size="11">#{html.escape(group)}</text>')
                ly += 18

        svg.append(f'<rect x="0" y="0" width="{total_width}" height="{total_height}" '
                    f'fill="none" stroke="{self.ACCENT_SOFT}" stroke-width="2" opacity="0.5"/>')
        svg.append("</svg>")

        filepath = self.files_dir / f"graph_{uuid.uuid4().hex[:8]}.svg"
        filepath.write_text("\n".join(svg), encoding="utf-8")
        return filepath

class ArchiveTool(Tool):
    def __init__(self):
        super().__init__("archive", "Создание ZIP архивов", "◫")
        self.files_dir = FILES_DIR

    async def execute(self, query: str, files: Optional[List[str]] = None, **kwargs) -> ToolResult:
        try:
            if not files:
                files = kwargs.get("file_list", [])
            if not files:
                return ToolResult(self.name, False, "No files specified for archive")
            archive_name = kwargs.get("archive_name", f"archive_{uuid.uuid4().hex[:8]}.zip")
            if not archive_name.endswith(".zip"):
                archive_name += ".zip"
            archive_path = self.files_dir / archive_name
            with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                for f in files:
                    # Разрешаем архивировать только файлы внутри FILES_DIR — берём
                    # basename, чтобы отбросить любые ../ или абсолютные пути,
                    # которые могли бы указать за пределы рабочей директории бота.
                    safe_name = Path(f).name
                    fpath = self.files_dir / safe_name
                    if fpath.exists() and fpath.is_file():
                        zf.write(fpath, fpath.name)
            return ToolResult(
                self.name, True, f"Archive created: {archive_name}",
                {"filepath": str(archive_path), "files_included": len(files)}
            )
        except Exception as e:
            return ToolResult(self.name, False, f"Archive error: {str(e)}")

class ExecCodeTool(Tool):
    """Выполняет код пользователя в изолированном subprocess:
    - отдельная рабочая директория (только файлы, созданные ботом через file_create,
      никогда не сам e.py и не файлы других пользователей за пределами их сессии)
    - урезанный env: без BOT_TOKEN/FREEMODEL_TOKEN и прочих переменных процесса бота
    - жёсткий таймаут
    - обрезка вывода, чтобы не забить чат гигантским stdout
    - сеть не блокируется на уровне ОС (это невозможно сделать переносимо без
      root/namespaces), поэтому это НЕ полноценная security-песочница —
      только защита от случайных ошибок и утечки секретов процесса бота.
      Не использовать для действительно недоверенного/вредоносного кода.
    """

    SUPPORTED = {
        "python": {"ext": ".py", "cmd": ["python3", "{file}"]},
        "python3": {"ext": ".py", "cmd": ["python3", "{file}"]},
        "js": {"ext": ".js", "cmd": ["node", "{file}"]},
        "javascript": {"ext": ".js", "cmd": ["node", "{file}"]},
        "bash": {"ext": ".sh", "cmd": ["bash", "{file}"]},
        "sh": {"ext": ".sh", "cmd": ["bash", "{file}"]},
    }

    MAX_OUTPUT_CHARS = 3500
    TIMEOUT_SECONDS = 12

    def __init__(self):
        super().__init__("exec", "Выполнение кода в изолированной песочнице", "▶")
        # Отдельная директория под каждый запуск, физически отделённая от
        # директории с кодом бота (e.py) и от общей FILES_DIR с чужими данными.
        self.exec_root = BASE_DIR / "xgo_exec"
        self.exec_root.mkdir(exist_ok=True)

    async def execute(self, query: str, **kwargs) -> ToolResult:
        code = kwargs.get("code", query)
        language = str(kwargs.get("language", "python")).lower().strip()
        input_files = kwargs.get("input_files", [])  # опционально: имена файлов из FILES_DIR

        if not code or not code.strip():
            return ToolResult(self.name, False, "No code provided")

        spec = self.SUPPORTED.get(language)
        if not spec:
            return ToolResult(
                self.name, False,
                f"Unsupported language '{language}'. Supported: {', '.join(sorted(set(v['ext'] for v in self.SUPPORTED.values())))} "
                f"({', '.join(self.SUPPORTED.keys())})"
            )

        run_dir = self.exec_root / uuid.uuid4().hex[:12]
        run_dir.mkdir(parents=True, exist_ok=True)

        try:
            # Копируем только явно запрошенные файлы, созданные ботом ранее
            # (например таблицу-CSV, которую пользователь хочет обработать
            # скриптом) — никогда не даём доступ к произвольным путям на диске.
            for fname in input_files:
                safe_name = Path(fname).name  # отбрасываем любые ../ и абсолютные пути
                src = FILES_DIR / safe_name
                if src.exists() and src.is_file():
                    shutil.copy2(src, run_dir / safe_name)

            code_file = run_dir / f"main{spec['ext']}"
            code_file.write_text(code, encoding="utf-8")

            cmd = [c.replace("{file}", str(code_file)) for c in spec["cmd"]]

            # Урезанный env: не даём subprocess'у ничего из окружения процесса
            # бота (никаких токенов), только необходимый минимум для работы
            # интерпретатора.
            safe_env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": str(run_dir),
                "LANG": "C.UTF-8",
                "PYTHONDONTWRITEBYTECODE": "1",
            }

            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=str(run_dir),
                    env=safe_env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    stdout, stderr = await asyncio.wait_for(
                        proc.communicate(), timeout=self.TIMEOUT_SECONDS
                    )
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
                    return ToolResult(
                        self.name, False,
                        f"Execution timed out after {self.TIMEOUT_SECONDS}s (possible infinite loop)"
                    )
            except FileNotFoundError:
                return ToolResult(
                    self.name, False,
                    f"Interpreter for '{language}' not found on this server "
                    f"(command: {cmd[0]}). It may not be installed."
                )

            out_text = stdout.decode("utf-8", errors="replace")
            err_text = stderr.decode("utf-8", errors="replace")

            def _clip(s: str) -> str:
                if len(s) > self.MAX_OUTPUT_CHARS:
                    return s[: self.MAX_OUTPUT_CHARS] + f"\n... [обрезано, всего {len(s)} символов]"
                return s

            out_text, err_text = _clip(out_text), _clip(err_text)
            success = proc.returncode == 0

            result_text = f"Exit code: {proc.returncode}\n"
            if out_text:
                result_text += f"\n--- stdout ---\n{out_text}"
            if err_text:
                result_text += f"\n--- stderr ---\n{err_text}"
            if not out_text and not err_text:
                result_text += "\n(no output)"

            return ToolResult(
                self.name, success, result_text,
                {"returncode": proc.returncode, "stdout": out_text, "stderr": err_text, "language": language}
            )
        finally:
            # Всегда чистим временную директорию запуска — не оставляем
            # выполненный код и его артефакты валяться на диске.
            shutil.rmtree(run_dir, ignore_errors=True)

class PresentationTool(Tool):
    """Генерирует многостраничную PDF-презентацию в фиолетовой теме.
    Каждый слайд — заголовок + буллеты (или акцентный блок с одним тезисом).
    Требует reportlab; при его отсутствии или отсутствии подходящего TTF-шрифта
    честно сообщает об этом вместо генерации нечитаемого/ломаного PDF."""

    BG = (0.098, 0.086, 0.133)          # #191622
    PANEL = (0.129, 0.114, 0.180)       # #211d2e
    ACCENT = (0.635, 0.349, 1.0)        # #a259ff
    ACCENT_SOFT = (0.486, 0.302, 1.0)   # #7c4dff
    TEXT = (0.910, 0.890, 0.961)        # #e8e3f5
    SUBTEXT = (0.659, 0.608, 0.788)     # #a89bc9

    FONT_CANDIDATES = [
        # Inter — визуально ближе всего к San Francisco/SF Pro среди свободных
        # TTF-шрифтов, поэтому пробуем его первым, если он установлен на сервере.
        ("/usr/share/fonts/truetype/inter/Inter-Regular.ttf", "/usr/share/fonts/truetype/inter/Inter-Bold.ttf"),
        ("/usr/share/fonts/inter/Inter-Regular.ttf", "/usr/share/fonts/inter/Inter-Bold.ttf"),
        ("/usr/local/share/fonts/Inter-Regular.ttf", "/usr/local/share/fonts/Inter-Bold.ttf"),
        # DejaVu Sans — фолбэк: почти всегда есть на Linux и гарантированно
        # покрывает кириллицу, но выглядит менее "по-айосовски".
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/truetype/dejavu-sans/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu-sans/DejaVuSans-Bold.ttf"),
    ]

    def __init__(self):
        super().__init__("presentation", "Создание PDF-презентаций из нескольких слайдов", "▤")
        self.files_dir = FILES_DIR
        self._font_regular = None
        self._font_bold = None
        self._fonts_ready = False

    def _ensure_fonts(self) -> bool:
        if self._fonts_ready:
            return True
        try:
            from reportlab.pdfbase import pdfmetrics
            from reportlab.pdfbase.ttfonts import TTFont
        except ImportError:
            return False
        for regular_path, bold_path in self.FONT_CANDIDATES:
            if Path(regular_path).exists() and Path(bold_path).exists():
                try:
                    pdfmetrics.registerFont(TTFont("XGO-Regular", regular_path))
                    pdfmetrics.registerFont(TTFont("XGO-Bold", bold_path))
                    self._font_regular = "XGO-Regular"
                    self._font_bold = "XGO-Bold"
                    self._fonts_ready = True
                    return True
                except Exception as e:
                    logger.error(f"Failed to register font {regular_path}: {e}")
        return False

    async def execute(self, query: str, **kwargs) -> ToolResult:
        try:
            from reportlab.pdfgen import canvas
        except ImportError:
            return ToolResult(
                self.name, False,
                "reportlab is not installed on this server. Install it with: pip install reportlab"
            )

        slides = kwargs.get("slides", [])
        title = kwargs.get("title", "Presentation")
        if not slides:
            return ToolResult(self.name, False, "No slides provided (need at least one slide with a title)")

        if not self._ensure_fonts():
            return ToolResult(
                self.name, False,
                "No suitable TTF font (Inter or DejaVu) found on this server (needed for Cyrillic text in PDF). "
                "Install 'fonts-dejavu-core' (Debian/Ubuntu: apt install fonts-dejavu-core), "
                "or place Inter-Regular.ttf/Inter-Bold.ttf under /usr/share/fonts/truetype/inter/ for an iOS-like look."
            )

        try:
            filepath = self._render_pdf(slides, title)
            return ToolResult(
                self.name, True, f"Presentation rendered: {filepath.name} ({len(slides)} slides)",
                {"filepath": str(filepath), "type": "application/pdf", "slides": len(slides)}
            )
        except Exception as e:
            return ToolResult(self.name, False, f"Presentation error: {str(e)}")

    # ------------------------------------------------------------------
    @classmethod
    def _wrap_text(cls, text: str, max_width: float, font_name: str, font_size: int, string_width_fn) -> List[str]:
        words = str(text).split(" ")
        lines: List[str] = []
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if string_width_fn(candidate, font_name, font_size) <= max_width or not current:
                current = candidate
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)
        return lines or [""]

    def _render_pdf(self, slides: List[Dict], deck_title: str) -> Path:
        from reportlab.pdfgen import canvas
        from reportlab.pdfbase.pdfmetrics import stringWidth

        # 16:9 widescreen slide, comparable to a standard deck (960x540 pt)
        PAGE_W, PAGE_H = 960, 540
        MARGIN = 64

        filepath = self.files_dir / f"presentation_{uuid.uuid4().hex[:8]}.pdf"
        c = canvas.Canvas(str(filepath), pagesize=(PAGE_W, PAGE_H))
        c.setTitle(deck_title)

        for idx, slide in enumerate(slides):
            self._draw_slide(c, slide, idx, len(slides), PAGE_W, PAGE_H, MARGIN, stringWidth)
            c.showPage()

        c.save()
        return filepath

    def _draw_slide(self, c, slide: Dict, idx: int, total: int, W: float, H: float, margin: float, string_width_fn):
        kind = slide.get("type", "content")  # "title" | "content" | "accent"
        title_text = slide.get("title", "")
        bullets = slide.get("bullets", [])
        body_text = slide.get("body", "")

        # Фон
        c.setFillColorRGB(*self.BG)
        c.rect(0, 0, W, H, fill=1, stroke=0)

        # Тонкая декоративная рамка
        c.setStrokeColorRGB(*self.ACCENT_SOFT)
        c.setLineWidth(1.5)
        c.roundRect(10, 10, W - 20, H - 20, 8, fill=0, stroke=1)

        if kind == "title":
            # Титульный слайд: крупный заголовок по центру + подзаголовок
            c.setFillColorRGB(*self.ACCENT)
            c.setFont(self._font_bold, 40)
            title_w = string_width_fn(title_text, self._font_bold, 40)
            c.drawString((W - title_w) / 2, H / 2 + 10, title_text)
            if body_text:
                c.setFillColorRGB(*self.SUBTEXT)
                c.setFont(self._font_regular, 18)
                sub_w = string_width_fn(body_text, self._font_regular, 18)
                c.drawString((W - sub_w) / 2, H / 2 - 30, body_text)
            # Акцентная полоска снизу заголовка
            bar_w = 90
            c.setFillColorRGB(*self.ACCENT)
            c.roundRect((W - bar_w) / 2, H / 2 - 4, bar_w, 5, 2, fill=1, stroke=0)
        else:
            # Заголовок слайда сверху
            c.setFillColorRGB(*self.ACCENT)
            c.setFont(self._font_bold, 28)
            c.drawString(margin, H - margin - 10, title_text)
            c.setFillColorRGB(*self.ACCENT)
            c.roundRect(margin, H - margin - 26, 46, 4, 2, fill=1, stroke=0)

            content_top = H - margin - 60
            if kind == "accent" and body_text:
                # Один крупный акцентный тезис по центру панели
                panel_y = H / 2 - 70
                c.setFillColorRGB(*self.PANEL)
                c.roundRect(margin, panel_y, W - 2 * margin, 140, 12, fill=1, stroke=0)
                c.setStrokeColorRGB(*self.ACCENT)
                c.setLineWidth(2)
                c.line(margin + 24, panel_y + 20, margin + 24, panel_y + 120)
                c.setFillColorRGB(*self.TEXT)
                c.setFont(self._font_bold, 22)
                wrapped = self._wrap_text(body_text, W - 2 * margin - 80, self._font_bold, 22, string_width_fn)
                ty = panel_y + 100
                for line in wrapped[:4]:
                    c.drawString(margin + 48, ty, line)
                    ty -= 30
            else:
                # Список буллетов
                c.setFont(self._font_regular, 18)
                by = content_top
                bullet_max_width = W - 2 * margin - 34
                for bullet in bullets:
                    wrapped = self._wrap_text(str(bullet), bullet_max_width, self._font_regular, 18, string_width_fn)
                    # Маркер
                    c.setFillColorRGB(*self.ACCENT)
                    c.circle(margin + 6, by - 5, 3.5, fill=1, stroke=0)
                    c.setFillColorRGB(*self.TEXT)
                    for li, line in enumerate(wrapped):
                        c.drawString(margin + 24, by - li * 24, line)
                    by -= 24 * max(1, len(wrapped)) + 14
                    if by < margin + 40:
                        break  # защита от переполнения слайда

        # Номер слайда снизу справа
        c.setFillColorRGB(*self.SUBTEXT)
        c.setFont(self._font_regular, 11)
        page_label = f"{idx + 1} / {total}"
        label_w = string_width_fn(page_label, self._font_regular, 11)
        c.drawString(W - margin - label_w, 24, page_label)

class GitHubCommitTool(Tool):
    """Создаёт/обновляет файл в подключённом GitHub-репозитории пользователя.
    Требует, чтобы пользователь заранее подключил репозиторий через /github."""

    def __init__(self):
        super().__init__("github_commit", "Создание/обновление файлов в подключённом GitHub-репозитории", "⌥")

    async def execute(self, query: str, **kwargs) -> ToolResult:
        user_id = kwargs.get("_user_id")  # прокидывается агентским циклом, не моделью
        path = kwargs.get("path", "")
        content = kwargs.get("content", "")
        message = kwargs.get("message", "Update via XGO bot")

        if not user_id:
            return ToolResult(self.name, False, "Internal error: no user context")
        conn = state.get_github_connection(user_id)
        if not conn:
            return ToolResult(
                self.name, False,
                "No GitHub repository connected. Ask the user to run /github and connect one first."
            )
        if not path or content is None:
            return ToolResult(self.name, False, "Both 'path' and 'content' are required")

        client = GitHubClient(conn.token, conn.owner, conn.repo, conn.branch)
        ok, result_msg = await client.create_or_update_file(path, content, message)
        return ToolResult(self.name, ok, result_msg, {"path": path, "repo": f"{conn.owner}/{conn.repo}"})

class GitHubReadTool(Tool):
    """Читает структуру и содержимое подключённого GitHub-репозитория —
    нужен, чтобы модель могла реально ОПРЕДЕЛИТЬ стек проекта (по package.json,
    Cargo.toml, pyproject.toml и т.п.) перед тем как писать под него что-либо
    (например GitHub Actions workflow), а не угадывать вслепую."""

    def __init__(self):
        super().__init__("github_read", "Просмотр структуры и содержимого файлов в подключённом GitHub-репозитории", "⌕")

    async def execute(self, query: str, **kwargs) -> ToolResult:
        user_id = kwargs.get("_user_id")
        action = str(kwargs.get("action", "list_files")).lower().strip()

        if not user_id:
            return ToolResult(self.name, False, "Internal error: no user context")
        conn = state.get_github_connection(user_id)
        if not conn:
            return ToolResult(
                self.name, False,
                "No GitHub repository connected. Ask the user to run /github and connect one first."
            )
        client = GitHubClient(conn.token, conn.owner, conn.repo, conn.branch)

        if action == "list_files":
            ok, result = await client.list_repo_tree()
            if not ok:
                return ToolResult(self.name, False, str(result))
            files_text = "\n".join(result)
            return ToolResult(self.name, True, f"Files in {conn.owner}/{conn.repo}:\n{files_text}", {"count": len(result)})

        if action == "read_file":
            path = kwargs.get("path", "")
            if not path:
                return ToolResult(self.name, False, "'path' is required for action=read_file")
            ok, result = await client.read_file(path)
            if not ok:
                return ToolResult(self.name, False, result)
            return ToolResult(self.name, True, f"Contents of {path}:\n\n{result}", {"path": path})

        return ToolResult(self.name, False, f"Unknown action '{action}'. Use 'list_files' or 'read_file'.")

class GitHubActionsTool(Tool):
    """Запускает GitHub Actions workflow (workflow_dispatch) в подключённом
    репозитории и может опросить статус последнего запуска. Не ждёт завершения
    синхронно — Actions асинхронны по своей природе, статус нужно запрашивать
    отдельным вызовом (action='status') через некоторое время."""

    def __init__(self):
        super().__init__("github_actions", "Запуск и проверка статуса GitHub Actions workflow", "⚙")

    async def execute(self, query: str, **kwargs) -> ToolResult:
        user_id = kwargs.get("_user_id")
        action = kwargs.get("action", "trigger")  # "trigger" | "status"
        workflow_file = kwargs.get("workflow_file", "")

        if not user_id:
            return ToolResult(self.name, False, "Internal error: no user context")
        conn = state.get_github_connection(user_id)
        if not conn:
            return ToolResult(
                self.name, False,
                "No GitHub repository connected. Ask the user to run /github and connect one first."
            )
        if not workflow_file:
            return ToolResult(self.name, False, "'workflow_file' is required (e.g. 'build.yml')")

        client = GitHubClient(conn.token, conn.owner, conn.repo, conn.branch)

        if action == "status":
            ok, data = await client.get_latest_workflow_run(workflow_file)
            if not ok:
                return ToolResult(self.name, False, data.get("error", "Unknown error"))
            status = data["status"]
            conclusion = data.get("conclusion") or "pending"
            return ToolResult(
                self.name, True,
                f"Workflow status: {status}, conclusion: {conclusion}\n{data.get('html_url', '')}",
                data
            )
        else:
            inputs = kwargs.get("inputs")
            ok, msg = await client.trigger_workflow_dispatch(workflow_file, inputs)
            return ToolResult(self.name, ok, msg, {"workflow_file": workflow_file})

class ToolManager:
    def __init__(self):
        self.tools: Dict[str, Tool] = {
            "search": WebSearchTool(),
            "file_create": FileCreateTool(),
            "table": TableRenderTool(),
            "chart": ChartRenderTool(),
            "graph": GraphViewTool(),
            "archive": ArchiveTool(),
            "exec": ExecCodeTool(),
            "presentation": PresentationTool(),
            "github_commit": GitHubCommitTool(),
            "github_read": GitHubReadTool(),
            "github_actions": GitHubActionsTool(),
        }
        self.tool_usage_history: List[Dict] = []

    def get(self, name: str) -> Optional[Tool]:
        return self.tools.get(name)

    def list_tools(self) -> List[Tool]:
        return list(self.tools.values())

    async def execute_tool(self, name: str, query: str, **kwargs) -> ToolResult:
        tool = self.tools.get(name)
        if not tool:
            return ToolResult(name, False, f"Tool '{name}' not found")
        result = await tool.execute(query, **kwargs)
        self.tool_usage_history.append({
            "tool": name,
            "query": query,
            "success": result.success,
            "time": time.time()
        })
        return result

    # РАСШИРЕННОЕ ОБНАРУЖЕНИЕ ТУЛОВ
    def detect_needed_tools(self, query: str) -> List[str]:
        needed = []
        q_lower = query.lower()

        # Поиск — много новых триггеров
        search_keywords = [
            "найди", "поиск", "search", "google", "информация о", "что такое", "кто такой",
            "новости", "weather", "погода", "определение", "значение", "узнай", "поищи",
            "найти", "покажи", "расскажи про", "объясни", "что значит"
        ]
        if any(k in q_lower for k in search_keywords):
            needed.append("search")

        # Файлы
        file_keywords = [
            "создай файл", "create file", "напиши код", "write code", "сохрани", "файл",
            ".py", ".js", ".html", ".css", ".json", ".md", "script", "запиши файл",
            "сохранить файл", "создай скрипт", "сделай файл", "создать файл"
        ]
        if any(k in q_lower for k in file_keywords):
            needed.append("file_create")

        # Таблицы
        table_keywords = [
            "таблица", "таблицу", "таблиц", "table", "сравни", "compare", "статистика",
            "stats", "рейтинг", "создай таблицу", "сделай таблицу",
            "покажи таблицу", "выведи таблицу", "построй таблицу"
        ]
        if any(k in q_lower for k in table_keywords):
            needed.append("table")

        # Диаграммы/графики
        chart_keywords = [
            "chart", "график", "диаграмма", "диаграмму", "гистограмма", "bar chart",
            "построй график", "создай график", "визуализируй", "визуализация"
        ]
        if any(k in q_lower for k in chart_keywords):
            needed.append("chart")

        # Граф связей (обсидиан-стайл: заметки, ссылки, сеть)
        graph_keywords = [
            "граф связей", "граф заметок", "карта заметок", "сеть узлов", "network graph",
            "граф", "визуализируй связи", "obsidian", "wiki-ссылки", "mind map", "карта идей"
        ]
        if any(k in q_lower for k in graph_keywords):
            needed.append("graph")

        # Презентации
        presentation_keywords = [
            "презентация", "презентацию", "презентации", "слайды", "слайд",
            "presentation", "slides", "pptx", "сделай презентацию", "создай презентацию"
        ]
        if any(k in q_lower for k in presentation_keywords):
            needed.append("presentation")

        # Выполнение кода
        exec_keywords = [
            "запусти код", "выполни код", "run code", "execute", "протестируй код",
            "выполни этот", "запусти этот скрипт", "запусти скрипт", "выполни скрипт"
        ]
        if any(k in q_lower for k in exec_keywords):
            needed.append("exec")

        # GitHub
        github_commit_keywords = [
            "закоммить", "закоммить в гитхаб", "commit", "push to github", "запушь",
            "создай файл в репозитории", "создай файл в гитхабе", "сохрани в github"
        ]
        if any(k in q_lower for k in github_commit_keywords):
            needed.append("github_commit")

        github_actions_keywords = [
            "запусти actions", "github actions", "запусти workflow", "workflow",
            "собери проект", "скомпилируй", "запусти сборку", "ci/cd", "запусти билд"
        ]
        if any(k in q_lower for k in github_actions_keywords):
            needed.append("github_actions")

        # Создание workflow под конкретный проект — сначала обязателен просмотр
        # репозитория (github_read), иначе модель штампует шаблонный .yml вслепую
        create_workflow_keywords = [
            "создай workflow", "напиши workflow", "создай .yml", "напиши .yml",
            "настрой ci", "настрой ci/cd", "создай ci", "добавь workflow",
            "создай action", "напиши action для"
        ]
        if any(k in q_lower for k in create_workflow_keywords):
            needed.append("github_read")

        # Архивы
        archive_keywords = ["архив", "archive", "zip", "сжать", "pack", "упакуй", "заархивируй"]
        if any(k in q_lower for k in archive_keywords):
            needed.append("archive")

        return needed
# ═══════════════════════════════════════════════════════════════════
# JSON PERSISTENCE HELPERS
# ═══════════════════════════════════════════════════════════════════

def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load {path}: {e}")
        return default

def _save_json_atomic(path: Path, data) -> None:
    """Атомарная запись: сначала во временный файл, потом rename,
    чтобы не повредить JSON при падении/одновременной записи."""
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        tmp_path.replace(path)
    except Exception as e:
        logger.error(f"Failed to save {path}: {e}")

# ═══════════════════════════════════════════════════════════════════
# BOT SETTINGS (персистентные настройки, редактируются из панели)
# ═══════════════════════════════════════════════════════════════════
SETTINGS_FILE = DATA_DIR / "bot_settings.json"

DEFAULT_BOT_SETTINGS = {
    "bot_token": None,          # None -> используется захардкоженный BOT_TOKEN выше
    "webhook_mode": "polling",  # бот всегда работает через long polling (см. main()) -- поле чисто информационное
    "webhook_url": "",
    "start_message": "",        # пусто -> дефолтный текст в cmd_start
    "pending_message": "",      # пусто -> дефолтный текст для неодобренных
    "blocked_message": "",      # пусто -> дефолтный текст для заблокированных
    "rate_limit": 30,           # запросов на генерацию в минуту на юзера (кроме владельца)
    "session_ttl": 60,          # минут неактивности до сброса истории диалога юзера
    "mod_timeout": 15,          # секунд ожидания ответа от мода при HTTP-вызове
}


class BotSettingsStore:
    """Настройки панели (вкладка «Настройки») -- персистятся в
    xgo_data/bot_settings.json и реально влияют на поведение бота (см.
    RateLimiter, BotState.get_session, MOD_HTTP_TIMEOUT_SECONDS, cmd_start),
    а не только отображаются в UI."""

    def __init__(self):
        data = _load_json(SETTINGS_FILE, {})
        self.data = {**DEFAULT_BOT_SETTINGS, **data}

    def get(self, key: str, default=None):
        return self.data.get(key, default)

    def update(self, patch: dict) -> None:
        for k, v in patch.items():
            if k in DEFAULT_BOT_SETTINGS and v is not None:
                self.data[k] = v
        _save_json_atomic(SETTINGS_FILE, self.data)


bot_settings = BotSettingsStore()


class RateLimiter:
    """Простой sliding-window rate limit на юзера: не больше N запросов на
    генерацию в минуту (лимит N настраивается в панели). Держим только в
    памяти -- это защита от одного юзера, заваливающего бота запросами
    прямо сейчас, переживать рестарт процесса ей не нужно."""

    def __init__(self):
        self._hits: Dict[int, List[float]] = {}

    def check(self, user_id: int, limit_per_min: int) -> bool:
        """True — можно продолжать, False — лимит на эту минуту исчерпан."""
        now = time.time()
        hits = self._hits.setdefault(user_id, [])
        cutoff = now - 60
        while hits and hits[0] < cutoff:
            hits.pop(0)
        if len(hits) >= limit_per_min:
            return False
        hits.append(now)
        return True


rate_limiter = RateLimiter()

COMMANDS_FILE = DATA_DIR / "custom_commands.json"


class CommandRegistry:
    """Кастомные команды, которые владелец добавляет из панели (вкладка
    «Команды»): либо статический текстовый ответ, либо привязка к моду
    (тогда команда работает как /ask, но с подсказкой использовать
    конкретный мод -- см. handle_custom_command). Порядок в списке решает
    приоритет отображения в панели; на диспетчеризацию не влияет, т.к.
    имена команд уникальны."""

    def __init__(self):
        data = _load_json(COMMANDS_FILE, None)
        self.commands: List[dict] = (data or {}).get("commands", [])

    def _save(self) -> None:
        _save_json_atomic(COMMANDS_FILE, {"commands": self.commands})

    def list(self) -> List[dict]:
        return self.commands

    @staticmethod
    def _normalize(name: str) -> str:
        name = name.strip().lstrip("/")
        return f"/{name}"

    def find(self, name: str) -> Optional[dict]:
        name = self._normalize(name)
        return next((c for c in self.commands if c["name"] == name), None)

    def add(self, name: str, description: str, mod_id: Optional[str], response: Optional[str]) -> dict:
        name = self._normalize(name)
        if len(name) < 2:
            raise ValueError("название команды не может быть пустым")
        if self.find(name):
            raise ValueError(f"команда {name} уже существует")
        if not mod_id and not response:
            raise ValueError("укажи модуль или текст ответа")
        entry = {
            "name": name,
            "description": description.strip() if description else "",
            "mod_id": mod_id or None,
            "response": response.strip() if response else None,
            "enabled": True,
            "added_at": time.time(),
        }
        self.commands.append(entry)
        self._save()
        return entry

    def toggle(self, name: str) -> dict:
        entry = self.find(name)
        if not entry:
            raise ValueError("команда не найдена")
        entry["enabled"] = not entry["enabled"]
        self._save()
        return entry

    def reorder(self, from_idx: int, to_idx: int) -> None:
        if not (0 <= from_idx < len(self.commands)) or not (0 <= to_idx < len(self.commands)):
            raise ValueError("индекс вне диапазона")
        item = self.commands.pop(from_idx)
        self.commands.insert(to_idx, item)
        self._save()


command_registry = CommandRegistry()

# ═══════════════════════════════════════════════════════════════════
# STATE MANAGEMENT
# ═══════════════════════════════════════════════════════════════════

class BotState:
    def __init__(self):
        self.sessions: dict[int, UserSession] = {}
        self.pending_requests: dict[str, PendingRequest] = {}
        self.approved_users: set[int] = set()
        self.blocked_users: set[int] = set()
        self.owner_notifications: bool = True
        self.global_stats = {"total_requests": 0, "total_tokens": 0, "total_tools_used": 0}
        self.pending_prompts: dict[str, dict] = {}
        self.github_connections: dict[int, GitHubConnection] = {}
        self.skill_manager = SkillManager()
        self.tool_manager = ToolManager()
        self._load_persisted()

    # ------------------------------------------------------------------
    # Персистентность: approved/blocked/pending/pending_prompts переживают
    # рестарт бота. pending_prompts -- это кнопки "Сгенерировать"/"Параметры"/
    # "Скиллы"; раньше жили только в памяти процесса, поэтому любой рестарт
    # (краш, деплой, OOM на тесном хостинге) делал их все "устаревшими" для
    # реальных владельцев, даже если TTL ещё не истёк.
    # ------------------------------------------------------------------
    def _load_persisted(self):
        approved = _load_json(APPROVED_USERS_FILE, [])
        blocked = _load_json(BLOCKED_USERS_FILE, [])
        self.approved_users = set(int(u) for u in approved)
        self.blocked_users = set(int(u) for u in blocked)

        pending_raw = _load_json(PENDING_REQUESTS_FILE, {})
        for req_id, data in pending_raw.items():
            try:
                self.pending_requests[req_id] = PendingRequest(**data)
            except Exception as e:
                logger.error(f"Skipping malformed pending request {req_id}: {e}")

        gh_raw = _load_json(GITHUB_CONNECTIONS_FILE, {})
        for uid_str, data in gh_raw.items():
            try:
                self.github_connections[int(uid_str)] = GitHubConnection(**data)
            except Exception as e:
                logger.error(f"Skipping malformed github connection for {uid_str}: {e}")

        prompts_raw = _load_json(PENDING_PROMPTS_FILE, {})
        now = time.time()
        loaded_prompts = 0
        for prompt_id, data in prompts_raw.items():
            try:
                # Не грузим уже протухшие по TTL записи -- не имеет смысла
                # тащить их в память только чтобы тут же выкинуть.
                if now - data.get("created_at", now) > PENDING_PROMPT_TTL_SECONDS:
                    continue
                params_raw = data.get("params") or {}
                data = dict(data)
                data["params"] = GenerationParams(
                    max_tokens=params_raw.get("max_tokens", DEFAULT_MAX_TOKENS),
                    temperature=params_raw.get("temperature", DEFAULT_TEMPERATURE),
                    top_p=params_raw.get("top_p", DEFAULT_TOP_P),
                )
                self.pending_prompts[prompt_id] = data
                loaded_prompts += 1
            except Exception as e:
                logger.error(f"Skipping malformed pending prompt {prompt_id}: {e}")

        logger.info(
            f"Loaded state: {len(self.approved_users)} approved, "
            f"{len(self.blocked_users)} blocked, {len(self.pending_requests)} pending, "
            f"{len(self.github_connections)} github connections, "
            f"{loaded_prompts} pending_prompts (buttons survived restart)"
        )

    def save_pending_prompts(self):
        """Сериализует pending_prompts на диск. GenerationParams -- единственное
        не-примитивное поле, раскладываем его в обычный dict вручную."""
        raw = {}
        for prompt_id, data in self.pending_prompts.items():
            try:
                entry = dict(data)
                params = entry.get("params")
                if isinstance(params, GenerationParams):
                    entry["params"] = {
                        "max_tokens": params.max_tokens,
                        "temperature": params.temperature,
                        "top_p": params.top_p,
                    }
                raw[prompt_id] = entry
            except Exception as e:
                logger.error(f"Failed to serialize pending prompt {prompt_id}: {e}")
        _save_json_atomic(PENDING_PROMPTS_FILE, raw)

    def _save_approved(self):
        _save_json_atomic(APPROVED_USERS_FILE, sorted(self.approved_users))

    def _save_blocked(self):
        _save_json_atomic(BLOCKED_USERS_FILE, sorted(self.blocked_users))

    def _save_pending(self):
        raw = {
            req_id: {
                "request_id": r.request_id,
                "user_id": r.user_id,
                "username": r.username,
                "first_name": r.first_name,
                "query": r.query,
                "chat_id": r.chat_id,
                "message_id": r.message_id,
                "created_at": r.created_at,
            }
            for req_id, r in self.pending_requests.items()
        }
        _save_json_atomic(PENDING_REQUESTS_FILE, raw)

    def _save_github_connections(self):
        raw = {
            str(uid): {
                "user_id": conn.user_id,
                "token": conn.token,
                "owner": conn.owner,
                "repo": conn.repo,
                "branch": conn.branch,
                "connected_at": conn.connected_at,
            }
            for uid, conn in self.github_connections.items()
        }
        _save_json_atomic(GITHUB_CONNECTIONS_FILE, raw)

    def set_github_connection(self, conn: "GitHubConnection"):
        self.github_connections[conn.user_id] = conn
        self._save_github_connections()

    def get_github_connection(self, user_id: int) -> Optional["GitHubConnection"]:
        return self.github_connections.get(user_id)

    def remove_github_connection(self, user_id: int):
        if user_id in self.github_connections:
            del self.github_connections[user_id]
            self._save_github_connections()

    def add_pending_request(self, req: "PendingRequest"):
        # Не плодим дубликаты: если у этого пользователя уже есть
        # необработанная заявка, не создаём вторую — иначе владелец
        # видит две карточки на одного человека и путается при одобрении.
        for existing in self.pending_requests.values():
            if existing.user_id == req.user_id:
                return existing
        self.pending_requests[req.request_id] = req
        self._save_pending()
        return req

    def pop_pending_request(self, request_id: str) -> Optional["PendingRequest"]:
        req = self.pending_requests.pop(request_id, None)
        if req is not None:
            self._save_pending()
        return req

    def get_session(self, user_id: int) -> UserSession:
        if user_id not in self.sessions:
            self.sessions[user_id] = UserSession(user_id=user_id)
            return self.sessions[user_id]
        session = self.sessions[user_id]
        ttl_seconds = int(bot_settings.get("session_ttl", 60) or 60) * 60
        if time.time() - session.updated_at > ttl_seconds:
            # История диалога протухла по TTL неактивности -- начинаем с
            # чистого листа, но настройки самого юзера (модель/параметры/
            # тулы/скиллы) он выбирал явно, их не трогаем.
            self.sessions[user_id] = UserSession(
                user_id=user_id,
                model=session.model,
                max_tokens=session.max_tokens,
                temperature=session.temperature,
                top_p=session.top_p,
                preferred_tools=session.preferred_tools,
                active_skills=session.active_skills,
            )
        return self.sessions[user_id]

    def is_approved(self, user_id: int) -> bool:
        return user_id == OWNER_ID or user_id in self.approved_users

    def approve_user(self, user_id: int):
        self.approved_users.add(user_id)
        self.blocked_users.discard(user_id)
        self._save_approved()
        self._save_blocked()

    def block_user(self, user_id: int):
        self.blocked_users.add(user_id)
        self.approved_users.discard(user_id)
        self._save_approved()
        self._save_blocked()

state = BotState()

# ═══════════════════════════════════════════════════════════════════
# FREEMODEL API CLIENT
# ═══════════════════════════════════════════════════════════════════

PROVIDERS_FILE = DATA_DIR / "providers.json"


class ProviderRegistry:
    """Список настроенных API-провайдеров моделей + какой из них сейчас
    активен ("текущая модель"). Персистится в xgo_data/providers.json,
    редактируется из панели (Настройки → Модель) без перезапуска бота --
    в отличие от старого FALLBACK_PROVIDERS (переменная окружения, которую
    поддерживаем и дальше как дополнительный статический хвост цепочки для
    обратной совместимости)."""

    def __init__(self):
        data = _load_json(PROVIDERS_FILE, None)
        if not data or not data.get("providers"):
            data = self._seed_defaults()
            _save_json_atomic(PROVIDERS_FILE, data)
        self.providers: List[dict] = data["providers"]
        self.active_id: str = data.get("active_id") or self.providers[0]["id"]
        self._migrate_add_known_defaults()

    @staticmethod
    def _seed_defaults() -> dict:
        """Изначальный набор моделей: старый FreeModel-провайдер (чтобы
        поведение бота не менялось после апдейта) + другие модели FreeModel
        (luna/terra) + два TokenRouter-провайдера, добавленные владельцем
        через панель/чат."""
        now = time.time()
        providers = [
            {
                "id": "freemodel-default",
                "label": f"FreeModel · {MODEL_NAME}",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": MODEL_NAME,
                "added_at": now,
            },
            {
                "id": "aihubmix-glm",
                "label": "aihubmix · coding-glm-5.3-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "coding-glm-5.3-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-glm-flash",
                "label": "aihubmix · coding-glm-5.3-flash-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "coding-glm-5.3-flash-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-kimi",
                "label": "aihubmix · coding-kimi-k3-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "coding-kimi-k3-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-minimax",
                "label": "aihubmix · coding-minimax-m3-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "coding-minimax-m3-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-gemini",
                "label": "aihubmix · gemini-3.7-flash-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "gemini-3.7-flash-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-gemini-3-flash",
                "label": "aihubmix · gemini-3-flash-preview-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "gemini-3-flash-preview-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-gpt4o",
                "label": "aihubmix · gpt-4o-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "gpt-4o-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-gpt41",
                "label": "aihubmix · gpt-4.1-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "gpt-4.1-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-mimo-pro",
                "label": "aihubmix · xiaomi-mimo-v2.5-pro-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "xiaomi-mimo-v2.5-pro-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-ling",
                "label": "aihubmix · ling-3.0-flash-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "ling-3.0-flash-free",
                "added_at": now,
            },
            {
                "id": "aihubmix-minimax-m3-vision",
                "label": "aihubmix · minimax-m3-free",
                "base_url": FREEMODEL_URL,
                "token": FREEMODEL_TOKEN,
                "model": "minimax-m3-free",
                "added_at": now,
            },
        ]
        return {"providers": providers, "active_id": providers[0]["id"]}

    def _migrate_add_known_defaults(self) -> None:
        """Довешивает новые модели, появившиеся уже ПОСЛЕ первого запуска
        бота -- у кого providers.json уже существует и был создан до того,
        как luna/terra попали в _seed_defaults, они иначе никогда бы их не
        увидели. Не трогает активную модель и ранее добавленные владельцем
        провайдеры."""
        known_extra = [
            {"id": "aihubmix-glm", "label": "aihubmix · coding-glm-5.3-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "coding-glm-5.3-free"},
            {"id": "aihubmix-glm-flash", "label": "aihubmix · coding-glm-5.3-flash-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "coding-glm-5.3-flash-free"},
            {"id": "aihubmix-kimi", "label": "aihubmix · coding-kimi-k3-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "coding-kimi-k3-free"},
            {"id": "aihubmix-minimax", "label": "aihubmix · coding-minimax-m3-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "coding-minimax-m3-free"},
            {"id": "aihubmix-gemini", "label": "aihubmix · gemini-3.7-flash-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "gemini-3.7-flash-free"},
            {"id": "aihubmix-gemini-3-flash", "label": "aihubmix · gemini-3-flash-preview-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "gemini-3-flash-preview-free"},
            {"id": "aihubmix-gpt4o", "label": "aihubmix · gpt-4o-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "gpt-4o-free"},
            {"id": "aihubmix-gpt41", "label": "aihubmix · gpt-4.1-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "gpt-4.1-free"},
            {"id": "aihubmix-mimo-pro", "label": "aihubmix · xiaomi-mimo-v2.5-pro-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "xiaomi-mimo-v2.5-pro-free"},
            {"id": "aihubmix-ling", "label": "aihubmix · ling-3.0-flash-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "ling-3.0-flash-free"},
            {"id": "aihubmix-minimax-m3-vision", "label": "aihubmix · minimax-m3-free", "base_url": FREEMODEL_URL, "token": FREEMODEL_TOKEN, "model": "minimax-m3-free"},
        ]
        existing_ids = {p["id"] for p in self.providers}
        changed = False
        for extra in known_extra:
            if extra["id"] not in existing_ids:
                self.providers.append({**extra, "added_at": time.time()})
                changed = True
        if changed:
            self._save()

    def _save(self) -> None:
        _save_json_atomic(PROVIDERS_FILE, {"providers": self.providers, "active_id": self.active_id})

    def list(self) -> List[dict]:
        return self.providers

    def get(self, provider_id: str) -> Optional[dict]:
        return next((p for p in self.providers if p["id"] == provider_id), None)

    def get_active(self) -> dict:
        return self.get(self.active_id) or self.providers[0]

    def add(self, label: str, base_url: str, token: str, model: str) -> dict:
        pid = f"custom-{uuid.uuid4().hex[:8]}"
        entry = {
            "id": pid,
            "label": label.strip() or model,
            "base_url": base_url.rstrip("/"),
            "token": token,
            "model": model,
            "added_at": time.time(),
        }
        self.providers.append(entry)
        self._save()
        return entry

    def remove(self, provider_id: str) -> None:
        if provider_id == self.active_id:
            raise ValueError("нельзя удалить активную модель -- сначала переключись на другую")
        if not self.get(provider_id):
            raise ValueError("провайдер не найден")
        self.providers = [p for p in self.providers if p["id"] != provider_id]
        self._save()

    def set_active(self, provider_id: str) -> dict:
        p = self.get(provider_id)
        if not p:
            raise ValueError("провайдер не найден")
        self.active_id = provider_id
        self._save()
        return p

    def ordered_for_fallback(self) -> List[dict]:
        """Активный провайдер первым, остальные -- как резервные."""
        active = self.get_active()
        rest = [p for p in self.providers if p["id"] != active.get("id")]
        return [active] + rest


provider_registry = ProviderRegistry()


class FreeModelClient:
    """Клиент с мультипровайдерным fallback. Цепочка провайдеров на КАЖДЫЙ
    запрос собирается заново из ProviderRegistry (активный первым, остальные
    как резерв) + статический хвост из FALLBACK_PROVIDERS (env, для обратной
    совместимости) -- так переключение модели в панели действует сразу,
    без перезапуска бота и без пересоздания клиента."""

    async def chat_completion(
        self,
        messages: list[dict],
        model: str = None,
        stream: bool = False,
        max_tokens: int = None,
        temperature: float = None,
        top_p: float = None,
    ) -> dict:
        providers = list(provider_registry.ordered_for_fallback())
        for p in FALLBACK_PROVIDERS:
            if p.get("url") and p.get("token"):
                providers.append({
                    "base_url": p["url"].rstrip("/"),
                    "token": p["token"],
                    "model": p.get("model", MODEL_NAME),
                    "label": p["url"],
                })
        if not providers:
            raise RuntimeError("Нет ни одного настроенного провайдера модели")

        last_exc: Optional[Exception] = None
        for idx, provider in enumerate(providers):
            # Явно переданный model переопределяет провайдера (нужно, например,
            # чтобы всегда бить в конкретную модель независимо от активной) --
            # если его нет, у КАЖДОГО провайдера в цепочке используется его
            # СОБСТВЕННАЯ модель, а не одна и та же для всех.
            provider_model = model or provider["model"]
            payload = {
                "model": provider_model,
                "messages": messages,
                "stream": stream,
            }
            if max_tokens is not None:
                payload["max_tokens"] = max_tokens
            if temperature is not None:
                payload["temperature"] = temperature
            if top_p is not None:
                payload["top_p"] = top_p

            headers = {
                "Authorization": f"Bearer {provider['token']}",
                "Content-Type": "application/json",
            }
            logger.info(
                f"Chat completion using model: {provider_model} "
                f"(provider {idx + 1}/{len(providers)}: {provider['base_url']})"
            )
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        f"{provider['base_url']}/chat/completions",
                        headers=headers,
                        json=payload,
                        timeout=aiohttp.ClientTimeout(total=MODEL_CALL_TIMEOUT_SECONDS),
                    ) as resp:
                        if resp.status >= 400:
                            text = await resp.text()
                            raise RuntimeError(f"Provider {provider['base_url']} HTTP {resp.status}: {text[:500]}")
                        return await resp.json()
            except asyncio.TimeoutError:
                last_exc = RuntimeError(
                    f"Provider {provider['base_url']} did not respond within {MODEL_CALL_TIMEOUT_SECONDS}s"
                )
                logger.warning(f"{last_exc}; trying next provider" if idx + 1 < len(providers) else str(last_exc))
            except Exception as e:
                last_exc = e
                logger.warning(
                    f"Provider {provider['base_url']} failed: {e}"
                    + (" — trying next provider" if idx + 1 < len(providers) else "")
                )

        # Все провайдеры исчерпаны
        raise last_exc or RuntimeError("No providers configured")


fm_client = FreeModelClient()


# ═══════════════════════════════════════════════════════════════════
# GITHUB INTEGRATION
# ═══════════════════════════════════════════════════════════════════

class GitHubClient:
    """Тонкая обёртка над GitHub REST API: создание/обновление файлов
    (Contents API) и запуск/опрос workflow (Actions API)."""

    API_BASE = "https://api.github.com"

    def __init__(self, token: str, owner: str, repo: str, branch: str = "main"):
        self.token = token
        self.owner = owner
        self.repo = repo
        self.branch = branch
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def test_connection(self) -> Tuple[bool, str]:
        """Проверяет, что токен валиден и есть доступ к репозиторию."""
        url = f"{self.API_BASE}/repos/{self.owner}/{self.repo}"
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        perms = data.get("permissions", {})
                        can_push = perms.get("push", False)
                        return True, f"OK: {data.get('full_name')} (push={'yes' if can_push else 'no'})"
                    elif resp.status == 404:
                        return False, "Repository not found or token has no access to it"
                    elif resp.status == 401:
                        return False, "Invalid or expired token"
                    else:
                        text = await resp.text()
                        return False, f"GitHub API error {resp.status}: {text[:200]}"
        except Exception as e:
            return False, f"Connection failed: {e}"

    async def get_file_sha(self, path: str) -> Optional[str]:
        """Возвращает sha существующего файла в репо, если он есть (нужен для update)."""
        url = f"{self.API_BASE}/repos/{self.owner}/{self.repo}/contents/{path}"
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(
                    url, params={"ref": self.branch}, timeout=aiohttp.ClientTimeout(total=15)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data.get("sha")
                    return None
        except Exception:
            return None

    async def list_repo_tree(self, max_entries: int = 200) -> Tuple[bool, Union[List[str], str]]:
        """Возвращает плоский список путей всех файлов в репозитории (рекурсивно,
        через Git Trees API) — нужен модели, чтобы РЕАЛЬНО увидеть, какой это
        проект (package.json? Cargo.toml? pyproject.toml?), вместо того чтобы
        угадывать язык/фреймворк и писать шаблонный workflow вслепую."""
        url = f"{self.API_BASE}/repos/{self.owner}/{self.repo}/git/trees/{self.branch}"
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(
                    url, params={"recursive": "1"}, timeout=aiohttp.ClientTimeout(total=15)
                ) as resp:
                    if resp.status != 200:
                        text = await resp.text()
                        return False, f"GitHub API error {resp.status}: {text[:300]}"
                    data = await resp.json()
                    tree = data.get("tree", [])
                    paths = [item["path"] for item in tree if item.get("type") == "blob"]
                    if data.get("truncated"):
                        paths.append("... (tree truncated by GitHub API, repo is large)")
                    return True, paths[:max_entries]
        except Exception as e:
            return False, f"Request failed: {e}"

    async def read_file(self, path: str, max_chars: int = 4000) -> Tuple[bool, str]:
        """Читает содержимое конкретного файла из репо (например package.json,
        Cargo.toml, pyproject.toml) — чтобы модель могла посмотреть реальные
        зависимости/скрипты проекта перед тем как писать под него workflow."""
        import base64
        url = f"{self.API_BASE}/repos/{self.owner}/{self.repo}/contents/{path}"
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(
                    url, params={"ref": self.branch}, timeout=aiohttp.ClientTimeout(total=15)
                ) as resp:
                    if resp.status == 404:
                        return False, f"File not found: {path}"
                    if resp.status != 200:
                        text = await resp.text()
                        return False, f"GitHub API error {resp.status}: {text[:300]}"
                    data = await resp.json()
                    if data.get("encoding") != "base64":
                        return False, f"Unsupported encoding for {path}: {data.get('encoding')}"
                    raw = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
                    truncated = raw[:max_chars]
                    if len(raw) > max_chars:
                        truncated += f"\n... (truncated, file is {len(raw)} chars total)"
                    return True, truncated
        except Exception as e:
            return False, f"Request failed: {e}"

    async def create_or_update_file(
        self, path: str, content: str, commit_message: str
    ) -> Tuple[bool, str]:
        """Создаёт файл или обновляет существующий (Contents API требует sha для update)."""
        import base64
        url = f"{self.API_BASE}/repos/{self.owner}/{self.repo}/contents/{path}"
        existing_sha = await self.get_file_sha(path)
        payload = {
            "message": commit_message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "branch": self.branch,
        }
        if existing_sha:
            payload["sha"] = existing_sha
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.put(
                    url, json=payload, timeout=aiohttp.ClientTimeout(total=30)
                ) as resp:
                    if resp.status in (200, 201):
                        data = await resp.json()
                        commit_url = data.get("commit", {}).get("html_url", "")
                        action = "updated" if existing_sha else "created"
                        return True, f"File {action}: {path}\n{commit_url}"
                    else:
                        text = await resp.text()
                        return False, f"GitHub API error {resp.status}: {text[:300]}"
        except Exception as e:
            return False, f"Request failed: {e}"

    async def trigger_workflow_dispatch(
        self, workflow_file: str, inputs: Optional[Dict] = None
    ) -> Tuple[bool, str]:
        """Запускает workflow через workflow_dispatch. Требует, чтобы workflow_file
        уже существовал в репозитории (.github/workflows/<name>.yml) и имел
        триггер `on: workflow_dispatch:`."""
        url = f"{self.API_BASE}/repos/{self.owner}/{self.repo}/actions/workflows/{workflow_file}/dispatches"
        payload = {"ref": self.branch}
        if inputs:
            payload["inputs"] = inputs
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.post(
                    url, json=payload, timeout=aiohttp.ClientTimeout(total=15)
                ) as resp:
                    if resp.status == 204:
                        return True, f"Workflow '{workflow_file}' triggered on branch '{self.branch}'"
                    else:
                        text = await resp.text()
                        return False, f"GitHub API error {resp.status}: {text[:300]}"
        except Exception as e:
            return False, f"Request failed: {e}"

    async def get_latest_workflow_run(self, workflow_file: str) -> Tuple[bool, Dict]:
        """Возвращает данные о самом свежем запуске workflow (для опроса статуса
        после trigger_workflow_dispatch — сам запуск не возвращает run_id напрямую,
        GitHub API это ограничение, поэтому опрашиваем 'последний запуск')."""
        url = f"{self.API_BASE}/repos/{self.owner}/{self.repo}/actions/workflows/{workflow_file}/runs"
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(
                    url, params={"per_page": 1}, timeout=aiohttp.ClientTimeout(total=15)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        runs = data.get("workflow_runs", [])
                        if runs:
                            run = runs[0]
                            return True, {
                                "status": run.get("status"),        # queued/in_progress/completed
                                "conclusion": run.get("conclusion"),  # success/failure/None
                                "html_url": run.get("html_url"),
                                "run_id": run.get("id"),
                                "created_at": run.get("created_at"),
                            }
                        return False, {"error": "No workflow runs found yet"}
                    else:
                        text = await resp.text()
                        return False, {"error": f"GitHub API error {resp.status}: {text[:200]}"}
        except Exception as e:
            return False, {"error": f"Request failed: {e}"}


# ═══════════════════════════════════════════════════════════════════
# TEXT FORMATTING — с поддержкой блоков и файлов
# ═══════════════════════════════════════════════════════════════════

class TextFormatter:
    @classmethod
    def esc(cls, text: str) -> str:
        return html.escape(text or "", quote=False)

    @classmethod
    def md_to_html(cls, text: str) -> str:
        text = html.escape(text or "", quote=False)

        def _code_block(m):
            lang = m.group(1) or ""
            code = m.group(2)
            cls_attr = f' class="language-{html.escape(lang)}"' if lang else ""
            return f"<pre><code{cls_attr}>{code}</code></pre>"

        text = re.sub(r"```(\w*)\n?(.*?)```", _code_block, text, flags=re.DOTALL)
        text = re.sub(r"`([^`\n]+?)`", r"<code>\1</code>", text)
        text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
        text = re.sub(r"(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", text)
        return text

    @classmethod
    def format_header_tree(
        cls,
        version: str = "2.0.0",
        build: str = "2000",
        elapsed: float = 0,
        total_tokens: int = 0,
        reasoning_effort: str = "tree",
        model: str = MODEL_NAME,
        tools_used: int = 0,
    ) -> str:
        header = f"{SYM['bot']} <b>XGO {version}-main.build:{build}</b> {SYM['diamond']}  <code>{cls.esc(model)}</code>"
        tree_lines = [
            f"  {SYM['tree_t']}| {SYM['speed']} <b>Reasoning</b>: <code>{cls.esc(reasoning_effort)}</code> |",
            f"  {SYM['tree_t']}| {SYM['sparkle']} <b>Complete in</b> <code>{elapsed:.1f} sec</code> |",
            f"  {SYM['tree_t']}| {SYM['tokens']} <b>Tokens</b>: <code>{total_tokens}</code> |",
        ]
        if tools_used > 0:
            tree_lines.append(f"  {SYM['tree_l']}| {SYM['tool']} <b>Tools</b>: <code>{tools_used}</code> |")
        else:
            tree_lines.append(f"  {SYM['tree_l']}| {SYM['brain']} <b>Mode</b>: <code>direct</code> |")
        return header + "\n" + "\n".join(tree_lines)

    @classmethod
    def format_prompt_block(cls, prompt: str) -> str:
        escaped = cls.esc(prompt[:500])
        return (
            f"{SYM['prompt']} <b>Prompt:</b>\n"
            f"<blockquote expandable>{escaped}</blockquote>"
        )

    @classmethod
    def format_thinking_block(cls, thinking: str) -> str:
        thinking = thinking[:1500]
        escaped = cls.esc(thinking)
        if not escaped.strip():
            escaped = "No thinking process recorded..."
        # Если модель не использовала древовидный формат, оставляем как есть
        return (
            f"{SYM['think']} <b>Thinking Process:</b>\n"
            f"<blockquote expandable>{escaped}</blockquote>"
        )

    @classmethod
    def format_answer_block(cls, answer: str, page_num: int = 1, total_pages: int = 1) -> str:
        header = f"{SYM['answer']} <b>Answer:</b>"
        if total_pages > 1:
            header += f" {SYM['page']} <code>[{page_num}/{total_pages}]</code>"
        return f"{header}\n<blockquote expandable>{cls.md_to_html(answer)}</blockquote>"

    @classmethod
    def format_tools_block(cls, tools_results: List[ToolResult]) -> str:
        if not tools_results:
            return ""
        header = f"{SYM['tool']} <b>Tools Used:</b>"
        lines = []
        for tr in tools_results:
            icon = SYM['check'] if tr.success else SYM['cross']
            # exec отдаёт реальный вывод программы (stdout/stderr) — это и есть
            # то, что пользователь хочет увидеть, поэтому не обрезаем его так же
            # жёстко, как служебные сообщения других тулов ("Table rendered: x.svg").
            limit = 1200 if tr.tool_name == "exec" else 100
            preview = tr.result[:limit]
            if len(tr.result) > limit:
                preview += f"\n... [обрезано, всего {len(tr.result)} символов]"
            lines.append(f"{icon} <code>{tr.tool_name}</code>:\n{cls.esc(preview)}")
        body = "\n\n".join(lines)
        return f"{header}\n<blockquote expandable>{body}</blockquote>\n\n"

    @classmethod
    def format_agent_log(cls, tool_calls: List[Dict]) -> str:
        if not tool_calls:
            return ""
        header = f"{SYM['brain']} <b>Agent Log:</b>"
        lines = []
        for tc in tool_calls:
            tool_name = tc.get("tool", "unknown")
            args = tc.get("args", {})
            args_preview = ", ".join(f"{k}={XGOAgent._preview_arg_value(v)}" for k, v in list(args.items())[:2])
            lines.append(f"{SYM['tool']} <code>{cls.esc(tool_name)}({cls.esc(args_preview)})</code>")
        body = "\n".join(lines)
        return f"{header}\n<blockquote expandable>{body}</blockquote>\n\n"

    @classmethod
    def format_full_response(
        cls,
        prompt: str,
        thinking: str,
        answer: str,
        elapsed: float,
        tokens: dict,
        page_num: int = 1,
        total_pages: int = 1,
        version: str = "2.0.0",
        build: str = "2000",
        model: str = MODEL_NAME,
        tools_results: List[ToolResult] = None,
        tool_calls: List[Dict] = None,
    ) -> str:
        tools_used = len(tools_results) if tools_results else 0
        header = cls.format_header_tree(
            version=version,
            build=build,
            elapsed=elapsed,
            total_tokens=tokens.get("total_tokens", 0),
            model=model,
            tools_used=tools_used,
        )
        prompt_block = cls.format_prompt_block(prompt)
        thinking_block = cls.format_thinking_block(thinking)
        tools_block = cls.format_tools_block(tools_results or [])
        agent_log_block = cls.format_agent_log(tool_calls or [])
        answer_block = cls.format_answer_block(answer, page_num, total_pages)

        parts = [header, "", prompt_block, "", thinking_block]
        if agent_log_block:
            parts.extend(["", agent_log_block])
        if tools_block:
            parts.extend(["", tools_block])
        parts.extend(["", answer_block])

        return "\n".join(parts)

    @classmethod
    def split_into_pages(cls, text: str, max_chars: int = MAX_PAGE_CHARS) -> list[str]:
        if len(text) <= max_chars:
            return [text]
        pages = []
        remaining = text
        while remaining and len(pages) < MAX_PAGES:
            if len(remaining) <= max_chars:
                pages.append(remaining)
                break
            split_pos = remaining.rfind("\n\n", 0, max_chars)
            if split_pos == -1:
                split_pos = remaining.rfind("\n", 0, max_chars)
            if split_pos == -1:
                split_pos = remaining.rfind(". ", max_chars - 200, max_chars)
            if split_pos == -1:
                split_pos = max_chars
            pages.append(remaining[:split_pos].strip())
            remaining = remaining[split_pos:].strip()
        return pages

    @classmethod
    def format_pending_request(cls, req: PendingRequest) -> str:
        user_link = f'<a href="tg://user?id={req.user_id}">{cls.esc(req.first_name)}</a>'
        return (
            f"{SYM['lock']} <b>Новый запрос на доступ</b>\n\n"
            f"{SYM['circle']} Пользователь: {user_link}\n"
            f"{SYM['diamond']} ID: <code>{req.user_id}</code>\n"
            f"{SYM['prompt']} Запрос: <i>{cls.esc(req.query[:200])}</i>\n"
            f"{SYM['time']} Время: <code>{datetime.fromtimestamp(req.created_at).strftime('%H:%M:%S')}</code>"
        )

    @classmethod
    def format_welcome(cls, is_approved: bool = False) -> str:
        if is_approved:
            return (
                f"{SYM['sparkle']} <b>Добро пожаловать в XGO v2.0</b>\n\n"
                f"{SYM['bot']} Я — AI-ассистент с tree-style раздумьями\n"
                f"{SYM['think']} Каждый ответ проходит через структурированный анализ\n"
                f"{SYM['tool']} Встроенные тулы: поиск, файлы, таблицы, архивы\n"
                f"{SYM['skill']} Система скиллов для разных задач\n"
                f"{SYM['page']} Длинные ответы разбиваются на страницы\n"
                f"{SYM['brain']} Модель: <code>{cls.esc(provider_registry.get_active()['model'])}</code>\n\n"
                f"<b>Команды:</b>\n"
                f"<code>/ask &lt;вопрос&gt;</code> — задать вопрос\n"
                f"<code>/clear</code> — очистить историю\n"
                f"<code>/status</code> — статус сессии\n"
                f"<code>/settings</code> — настройки\n"
                f"<code>/skills</code> — управление скиллами\n"
                f"<code>/model</code> — выбрать модель\n"
                f"<code>/tools</code> — доступные тулы"
            )
        else:
            return (
                f"{SYM['lock']} <b>Доступ ограничен</b>\n\n"
                f"Вы не имеете доступа к боту.\n"
                f"Запрос отправлен владельцу на рассмотрение.\n\n"
                f"{SYM['pending']} Ожидайте разрешения..."
            )

# ═══════════════════════════════════════════════════════════════════
# KEYBOARD BUILDERS
# ═══════════════════════════════════════════════════════════════════

class KeyboardBuilder:
    @staticmethod
    def ask_user_buttons(pause_id: str, q_idx: int, options: List[str]) -> InlineKeyboardMarkup:
        """Кнопки для ОДНОГО вопроса ask_user: вариант(ы) от модели (1 кнопка
        на вариант, подписаны 1/2/3...) + отдельная кнопка свободного ответа
        через ForceReply. callback_data короткий (pause_id уже urlsafe uuid[:12])
        -- варианты не кодируем в data целиком, только их индекс, сам текст
        достаём из _paused_agents по (pause_id, q_idx, opt_idx) при нажатии."""
        rows = []
        for i, opt in enumerate(options):
            label = f"{i + 1}. {opt}" if len(options) > 1 else opt
            rows.append([InlineKeyboardButton(text=label[:64], callback_data=f"askans:{pause_id}:{q_idx}:{i}")])
        rows.append([InlineKeyboardButton(text=f"{SYM['typing']} Свой ответ", callback_data=f"askinput:{pause_id}:{q_idx}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def generate_button(prompt_id: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text=f"{SYM['generate']} Сгенерировать", callback_data=f"generate:{prompt_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['skill']} Скиллы", callback_data=f"skills_select:{prompt_id}"),
                InlineKeyboardButton(text=f"{SYM['settings']} Параметры", callback_data=f"params:{prompt_id}"),
            ],
        ])

    @staticmethod
    def pagination_buttons(page_num: int, total_pages: int, request_id: str) -> InlineKeyboardMarkup:
        buttons = []
        nav_row = []
        if page_num > 1:
            nav_row.append(InlineKeyboardButton(
                text=f"{SYM['back']} Назад",
                callback_data=f"page:{request_id}:{page_num - 1}"
            ))
        nav_row.append(InlineKeyboardButton(
            text=f"{SYM['page']} {page_num}/{total_pages}",
            callback_data="noop"
        ))
        if page_num < total_pages:
            nav_row.append(InlineKeyboardButton(
                text=f"Вперёд {SYM['forward']}",
                callback_data=f"page:{request_id}:{page_num + 1}"
            ))
        buttons.append(nav_row)

        action_row = [
            InlineKeyboardButton(text=f"{SYM['continue']} Продолжить", callback_data=f"continue:{request_id}"),
            InlineKeyboardButton(text=f"{SYM['regen_prompt']} Реген с промптом", callback_data=f"regen_prompt:{request_id}"),
        ]
        buttons.append(action_row)

        bottom_row = [
            InlineKeyboardButton(text=f"{SYM['regen']} Регенерировать", callback_data=f"regen:{request_id}"),
            InlineKeyboardButton(text=f"{SYM['clear']} Очистить", callback_data=f"clear:{request_id}"),
            InlineKeyboardButton(text=f"{SYM['history']} История", callback_data=f"history:{request_id}"),
        ]
        buttons.append(bottom_row)

        extra_row = [
            InlineKeyboardButton(text=f"{SYM['root']} Дерево", callback_data=f"tree:{request_id}"),
            InlineKeyboardButton(text=f"{SYM['file']} Файлы", callback_data=f"files:{request_id}"),
        ]
        buttons.append(extra_row)
        return InlineKeyboardMarkup(inline_keyboard=buttons)

    @staticmethod
    def single_page_buttons(request_id: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text=f"{SYM['continue']} Продолжить", callback_data=f"continue:{request_id}"),
                InlineKeyboardButton(text=f"{SYM['regen_prompt']} Реген с промптом", callback_data=f"regen_prompt:{request_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['regen']} Регенерировать", callback_data=f"regen:{request_id}"),
                InlineKeyboardButton(text=f"{SYM['clear']} Очистить", callback_data=f"clear:{request_id}"),
                InlineKeyboardButton(text=f"{SYM['history']} История", callback_data=f"history:{request_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['root']} Дерево", callback_data=f"tree:{request_id}"),
                InlineKeyboardButton(text=f"{SYM['file']} Файлы", callback_data=f"files:{request_id}"),
            ],
        ])

    @staticmethod
    def tree_page_buttons(request_id: str, page: int, total_pages: int) -> InlineKeyboardMarkup:
        """Дерево размышлений может быть длинным (много шагов/тулов) и не
        влезать в одно сообщение -- листаем его так же, как список юзеров
        в owner_users_menu, тем же паттерном (← N/M →)."""
        nav_row = []
        if page > 0:
            nav_row.append(InlineKeyboardButton(text=f"{SYM['back']}", callback_data=f"treepage:{request_id}:{page-1}"))
        if total_pages > 1:
            nav_row.append(InlineKeyboardButton(text=f"{SYM['page']} {page+1}/{total_pages}", callback_data="noop"))
        if page < total_pages - 1:
            nav_row.append(InlineKeyboardButton(text=f"{SYM['forward']}", callback_data=f"treepage:{request_id}:{page+1}"))
        rows = []
        if nav_row:
            rows.append(nav_row)
        rows.append([InlineKeyboardButton(text=f"{SYM['process']} Лог действий", callback_data=f"log:{request_id}")])
        rows.append([InlineKeyboardButton(text=f"{SYM['back']} К ответу", callback_data=f"backresult:{request_id}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def log_page_buttons(request_id: str, page: int, total_pages: int) -> InlineKeyboardMarkup:
        """Лог вызовов тулов -- та же постраничная схема, что и у дерева.
        Живёт ВНУТРИ экрана «Дерево»: кнопка «Назад к дереву» возвращает
        туда же, а не к финальному ответу (в основной клавиатуре ответа
        отдельной кнопки лога больше нет -- см. pagination_buttons)."""
        nav_row = []
        if page > 0:
            nav_row.append(InlineKeyboardButton(text=f"{SYM['back']}", callback_data=f"logpage:{request_id}:{page-1}"))
        if total_pages > 1:
            nav_row.append(InlineKeyboardButton(text=f"{SYM['page']} {page+1}/{total_pages}", callback_data="noop"))
        if page < total_pages - 1:
            nav_row.append(InlineKeyboardButton(text=f"{SYM['forward']}", callback_data=f"logpage:{request_id}:{page+1}"))
        rows = []
        if nav_row:
            rows.append(nav_row)
        rows.append([InlineKeyboardButton(text=f"{SYM['root']} Назад к дереву", callback_data=f"tree:{request_id}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def back_to_result_button(request_id: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text=f"{SYM['back']} Назад", callback_data=f"backresult:{request_id}")],
        ])

    @staticmethod
    def approval_buttons(request_id: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text=f"{SYM['check']} Разрешить", callback_data=f"approve:{request_id}"),
                InlineKeyboardButton(text=f"{SYM['cross']} Отклонить", callback_data=f"reject:{request_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['lock']} Заблокировать", callback_data=f"block:{request_id}"),
            ],
        ])

    @staticmethod
    def owner_panel() -> InlineKeyboardMarkup:
        notif_label = f"{SYM['notif']} Уведомления: {'ВКЛ' if state.owner_notifications else 'ВЫКЛ'}"
        return InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text=f"{SYM['stats']} Статистика", callback_data="stats"),
                InlineKeyboardButton(text=f"{SYM['users']} Пользователи", callback_data="users"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['queue']} Очередь", callback_data="queue"),
                InlineKeyboardButton(text=notif_label, callback_data="toggle_notif"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['skill']} Скиллы", callback_data="owner_skills"),
                InlineKeyboardButton(text=f"{SYM['tool']} Тулы", callback_data="owner_tools"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['tool']} Моды", callback_data="mods_menu"),
                InlineKeyboardButton(text=f"{SYM['refresh']} Обновить", callback_data="owner_refresh"),
            ],
        ])

    @staticmethod
    def owner_stats_menu() -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text=f"{SYM['back']} Назад в меню", callback_data="owner_back"),
                InlineKeyboardButton(text=f"{SYM['refresh']} Обновить", callback_data="stats"),
            ],
        ])

    @staticmethod
    def owner_users_menu(users: List[int], page: int = 0) -> InlineKeyboardMarkup:
        buttons = []
        per_page = 8
        start = page * per_page
        end = min(start + per_page, len(users))
        for i in range(start, end):
            uid = users[i]
            buttons.append([
                InlineKeyboardButton(text=f"{SYM['circle']} {uid}", callback_data=f"user_info:{uid}"),
                InlineKeyboardButton(text=f"{SYM['cross']} Заблокировать", callback_data=f"user_block:{uid}"),
            ])
        nav_row = []
        if page > 0:
            nav_row.append(InlineKeyboardButton(text=f"{SYM['back']}", callback_data=f"users_page:{page-1}"))
        nav_row.append(InlineKeyboardButton(text=f"{SYM['page']} {page+1}", callback_data="noop"))
        if end < len(users):
            nav_row.append(InlineKeyboardButton(text=f"{SYM['forward']}", callback_data=f"users_page:{page+1}"))
        if nav_row:
            buttons.append(nav_row)
        buttons.append([InlineKeyboardButton(text=f"{SYM['back']} Назад в меню", callback_data="owner_back")])
        return InlineKeyboardMarkup(inline_keyboard=buttons)

    @staticmethod
    def owner_queue_menu(requests: List[PendingRequest]) -> InlineKeyboardMarkup:
        buttons = []
        for req in requests[:10]:
            buttons.append([
                InlineKeyboardButton(
                    text=f"{req.first_name[:20]} ({req.request_id})",
                    callback_data=f"queue_view:{req.request_id}"
                ),
            ])
        buttons.append([InlineKeyboardButton(text=f"{SYM['back']} Назад в меню", callback_data="owner_back")])
        return InlineKeyboardMarkup(inline_keyboard=buttons)

    @staticmethod
    def params_buttons(prompt_id: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text=f"{SYM['diamond']} Модель", callback_data=f"param_model:{prompt_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['speed']} Температура", callback_data=f"param_temp:{prompt_id}"),
                InlineKeyboardButton(text=f"{SYM['tokens']} Max Tokens", callback_data=f"param_tokens:{prompt_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['decide']} Top-P", callback_data=f"param_topp:{prompt_id}"),
                InlineKeyboardButton(text=f"{SYM['tool']} Тулы", callback_data=f"param_tools:{prompt_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['back']} Назад к запросу", callback_data=f"back_to_gen:{prompt_id}"),
            ],
        ])

    @staticmethod
    def settings_params_buttons(prompt_id: str) -> InlineKeyboardMarkup:
        """Тот же набор кнопок, что и params_buttons, но без «Назад к
        запросу» -- у /settings нет реальной генерации, к которой можно
        вернуться (см. cmd_settings)."""
        return InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text=f"{SYM['diamond']} Модель", callback_data=f"param_model:{prompt_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['speed']} Температура", callback_data=f"param_temp:{prompt_id}"),
                InlineKeyboardButton(text=f"{SYM['tokens']} Max Tokens", callback_data=f"param_tokens:{prompt_id}"),
            ],
            [
                InlineKeyboardButton(text=f"{SYM['decide']} Top-P", callback_data=f"param_topp:{prompt_id}"),
                InlineKeyboardButton(text=f"{SYM['tool']} Тулы", callback_data=f"param_tools:{prompt_id}"),
            ],
        ])

    @staticmethod
    def model_selector(prompt_id: str, current_model: str) -> InlineKeyboardMarkup:
        rows = []
        for p in provider_registry.list():
            mark = f"{SYM['check']} " if p["model"] == current_model else ""
            rows.append([InlineKeyboardButton(text=f"{mark}{p['model']}", callback_data=f"set_model_p:{prompt_id}:{p['id']}")])
        rows.append([InlineKeyboardButton(text=f"{SYM['back']} Назад", callback_data=f"params:{prompt_id}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def temp_selector(prompt_id: str, current: float) -> InlineKeyboardMarkup:
        temps = [0.1, 0.3, 0.5, 0.7, 0.9, 1.0, 1.2, 1.5]
        rows = []
        row = []
        for i, t in enumerate(temps):
            mark = "✓ " if abs(t - current) < 0.05 else ""
            row.append(InlineKeyboardButton(
                text=f"{mark}{t}",
                callback_data=f"set_temp:{prompt_id}:{t}"
            ))
            if (i + 1) % 4 == 0:
                rows.append(row)
                row = []
        if row:
            rows.append(row)
        rows.append([InlineKeyboardButton(text=f"{SYM['back']} Назад", callback_data=f"params:{prompt_id}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def tokens_selector(prompt_id: str, current: int) -> InlineKeyboardMarkup:
        tokens = [512, 1024, 2048, 4096, 8192, 16384]
        rows = []
        row = []
        for i, t in enumerate(tokens):
            mark = "✓ " if t == current else ""
            row.append(InlineKeyboardButton(
                text=f"{mark}{t}",
                callback_data=f"set_tokens:{prompt_id}:{t}"
            ))
            if (i + 1) % 3 == 0:
                rows.append(row)
                row = []
        if row:
            rows.append(row)
        rows.append([InlineKeyboardButton(text=f"{SYM['back']} Назад", callback_data=f"params:{prompt_id}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def topp_selector(prompt_id: str, current: float) -> InlineKeyboardMarkup:
        topps = [0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 1.0]
        rows = []
        row = []
        for i, t in enumerate(topps):
            mark = "✓ " if abs(t - current) < 0.05 else ""
            row.append(InlineKeyboardButton(
                text=f"{mark}{t}",
                callback_data=f"set_topp:{prompt_id}:{t}"
            ))
            if (i + 1) % 4 == 0:
                rows.append(row)
                row = []
        if row:
            rows.append(row)
        rows.append([InlineKeyboardButton(text=f"{SYM['back']} Назад", callback_data=f"params:{prompt_id}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def tools_selector(prompt_id: str, active_tools: List[str]) -> InlineKeyboardMarkup:
        all_tools = [
            ("search", f"{SYM['search']} Поиск"),
            ("file_create", f"{SYM['file']} Файлы"),
            ("table", f"{SYM['table']} Таблицы"),
            ("chart", f"{SYM['chart']} Диаграммы"),
            ("graph", f"{SYM['node']} Граф связей"),
            ("archive", f"{SYM['archive']} Архивы"),
            ("exec", f"{SYM['step']} Выполнение кода"),
            ("presentation", f"{SYM['image']} Презентации"),
            ("github_commit", f"{SYM['upload']} GitHub коммит"),
            ("github_read", f"{SYM['download']} GitHub чтение"),
            ("github_actions", f"{SYM['process']} GitHub Actions"),
        ]
        rows = []
        for tid, tname in all_tools:
            mark = f"{SYM['check']} " if tid in active_tools else f"{SYM['cross']} "
            rows.append([InlineKeyboardButton(
                text=f"{mark}{tname}",
                callback_data=f"toggle_tool:{prompt_id}:{tid}"
            )])
        rows.append([InlineKeyboardButton(text=f"{SYM['back']} Назад", callback_data=f"params:{prompt_id}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    @staticmethod
    def skills_menu(prompt_id: str, active_skills: List[str]) -> InlineKeyboardMarkup:
        skills = state.skill_manager.list_skills()
        rows = []
        for skill in skills:
            mark = f"{SYM['check']} " if skill.name in active_skills else f"{SYM['cross']} "
            rows.append([InlineKeyboardButton(
                text=f"{mark}{skill.icon} {skill.name}",
                callback_data=f"toggle_skill:{prompt_id}:{skill.name}"
            )])
        rows.append([InlineKeyboardButton(text=f"{SYM['back']} Назад", callback_data=f"back_to_gen:{prompt_id}")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

# ═══════════════════════════════════════════════════════════════════
# BOT INITIALIZATION
# ═══════════════════════════════════════════════════════════════════

bot = Bot(
    token=bot_settings.get("bot_token") or BOT_TOKEN,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML)
)
dp = Dispatcher()
router = Router()
dp.include_router(router)

@dp.errors()
async def global_error_handler(event: ErrorEvent) -> bool:
    """Последний рубеж: ловит любое исключение, не пойманное внутри самого
    хендлера, логирует его и не даёт диспетчеру/процессу упасть целиком.
    Без этого один необработанный edge-case на любой кнопке или команде мог
    уронить весь процесс — а рестарт на хостинге обнуляет всю in-memory
    память (pending_prompts, _response_cache), откуда и массовое
    "данные устарели" на всех старых кнопках после каждого падения."""
    logger.error(
        f"Unhandled exception in update handler: {event.exception}",
        exc_info=event.exception,
    )
    try:
        update = event.update
        chat_id = None
        if update.message:
            chat_id = update.message.chat.id
        elif update.callback_query and update.callback_query.message:
            chat_id = update.callback_query.message.chat.id
        if update.callback_query:
            try:
                await update.callback_query.answer("Произошла ошибка, попробуйте ещё раз", show_alert=True)
            except Exception:
                pass
        elif chat_id:
            await bot.send_message(chat_id, f"{SYM.get('cross', '✗')} Произошла внутренняя ошибка, попробуйте ещё раз")
    except Exception as notify_err:
        logger.error(f"Failed to notify user about unhandled error: {notify_err}")
    return True  # помечаем событие как обработанное, чтобы aiogram не пробрасывал его дальше

# ═══════════════════════════════════════════════════════════════════
# MOD SYSTEM -- удалённые "моды" на других серверах (мультисерверный режим)
# ═══════════════════════════════════════════════════════════════════
#
# Идея: Telegram-соединение (polling) держит только ЭТОТ процесс -- два
# процесса на одном токене конфликтуют (TelegramConflictError), поэтому
# моды НЕ подключаются к Telegram напрямую. Вместо этого:
#
#   1. Каждый мод -- это отдельный маленький HTTP-сервер на своём сервере
#      (1 порт, укладывается в лимиты типа LuneaHost 128MB). Мод сам решает
#      свою структуру кнопок и логику.
#   2. Мод регистрируется в этом боте командой /modadd (только владелец):
#      указывается mod_id, base_url и общий секрет.
#   3. Владелец добавляет для мода пункт в меню (кнопка с callback_data
#      "mod:<mod_id>:open"). При нажатии главный бот делает подписанный
#      HTTP-запрос к моду и просто ретранслирует пользователю то, что мод
#      вернул (текст + клавиатуру), включая дальнейшие кнопки мода.
#   4. Каждый запрос от бота к моду и любой запрос от мода к боту подписан
#      HMAC-SHA256 по общему секрету -- без валидной подписи запрос
#      отклоняется, так что ни мод не может подделать чужого пользователя,
#      ни посторонний сайт не может дёргать мод от лица бота.
#   5. Если моду нужно самому что-то прислать пользователю (не в ответ на
#      нажатие, а "по своей инициативе" -- например уведомление), у бота
#      поднят лёгкий aiohttp.web сервер на MOD_HOOK_PORT с эндпоинтом
#      POST /xgo/push, куда мод может подписанным запросом отправить
#      {"user_id":.., "text":.., "keyboard": [...]}.
#
# Всё состояние мода (что показывать, какие у него кнопки) -- ЦЕЛИКОМ на
# стороне мода. Главный бот только маршрутизирует и ничего не хранит про
# внутреннюю структуру мода, кроме списка зарегистрированных mod_id/URL.

import hmac
import hashlib

MODS_REGISTRY_FILE = DATA_DIR / "mods_registry.json"
MOD_HTTP_TIMEOUT_SECONDS = 15  # /xgo/callback должен отвечать быстро -- долгую
# работу (агент с несколькими LLM-шагами и тулами) мод обязан делать в
# фоне ПОСЛЕ быстрого ответа на callback, и присылать промежуточные/финальный
# результат через push_url (action="edit"), а не держать этот запрос открытым.
# Порт, на котором главный бот слушает входящие push-запросы от модов.
# 0 -- функция выключена (моды могут отвечать только на прямые запросы
# бота, не могут сами ничего прислать). Включается переменной окружения
# MOD_HOOK_PORT, потому что не на всех хостингах есть свободный порт.
MOD_HOOK_PORT = int(os.environ.get("MOD_HOOK_PORT", "0") or "0")
MOD_HOOK_HOST = os.environ.get("MOD_HOOK_HOST", "0.0.0.0")
# Публичный адрес, по которому МОД (может быть на другом хостинге) достучится
# до push-сервера бота через интернет -- например "http://1.2.3.4:8090" или
# "https://mybot.example.com". MOD_HOOK_HOST/PORT -- это то, на чём бот сам
# слушает локально; PUBLIC_URL -- то, что снаружи. Если они совпадают
# (бот и мод в одной сети), можно поставить MOD_HOOK_PUBLIC_URL такой же,
# как "http://<MOD_HOOK_HOST>:<MOD_HOOK_PORT>", но обычно это разные вещи --
# 0.0.0.0 не является адресом, на который извне можно постучаться.
MOD_HOOK_PUBLIC_URL = os.environ.get("MOD_HOOK_PUBLIC_URL", "").rstrip("/")


@dataclass
class ModConnection:
    mod_id: str            # короткий идентификатор, используется в callback_data: mod:<mod_id>:...
    base_url: str          # например https://myserver.lunea.host:PORT
    secret: str            # общий HMAC-секрет мод <-> бот
    title: str = ""        # человекочитаемое имя для меню
    added_at: float = field(default_factory=time.time)
    enabled: bool = True


class ModRegistry:
    """Реестр подключённых модов + подписанный HTTP-клиент к ним."""

    def __init__(self):
        self.mods: dict[str, ModConnection] = {}
        self._load()

    def _load(self):
        raw = _load_json(MODS_REGISTRY_FILE, {})
        changed = False
        for mod_id, data in raw.items():
            try:
                # Telegram допускает только строчные буквы в именах команд, и
                # наш дальнейший поиск мода по /<mod_id> тоже регистрозависим.
                # Если раньше мод был добавлен как "CLAWBACK" (например через
                # /modadd CLAWBACK ...), а пользователь пишет "/clawback" —
                # это два разных ключа словаря, мод молча не находится.
                # Приводим id к нижнему регистру при загрузке, чтобы старые
                # записи с заглавными буквами тоже заработали без /modadd заново.
                normalized_id = mod_id.strip().lower()
                if normalized_id != mod_id:
                    changed = True
                data["mod_id"] = normalized_id
                self.mods[normalized_id] = ModConnection(**data)
            except Exception as e:
                logger.error(f"Skipping malformed mod entry {mod_id}: {e}")
        if changed:
            self._save()

    def _save(self):
        raw = {
            mod_id: {
                "mod_id": m.mod_id,
                "base_url": m.base_url,
                "secret": m.secret,
                "title": m.title,
                "added_at": m.added_at,
                "enabled": m.enabled,
            }
            for mod_id, m in self.mods.items()
        }
        _save_json_atomic(MODS_REGISTRY_FILE, raw)

    def add(self, mod_id: str, base_url: str, secret: str, title: str = "") -> ModConnection:
        mod_id = mod_id.strip().lower()
        conn = ModConnection(mod_id=mod_id, base_url=base_url.rstrip("/"), secret=secret, title=title or mod_id)
        self.mods[mod_id] = conn
        self._save()
        return conn

    def remove(self, mod_id: str) -> bool:
        mod_id = mod_id.strip().lower()
        if mod_id in self.mods:
            del self.mods[mod_id]
            self._save()
            return True
        return False

    def get(self, mod_id: str) -> Optional[ModConnection]:
        return self.mods.get((mod_id or "").strip().lower())

    def list_enabled(self) -> List[ModConnection]:
        return [m for m in self.mods.values() if m.enabled]

    def reorder(self, from_idx: int, to_idx: int) -> None:
        items = list(self.mods.items())
        if not (0 <= from_idx < len(items)) or not (0 <= to_idx < len(items)):
            raise ValueError("индекс вне диапазона")
        item = items.pop(from_idx)
        items.insert(to_idx, item)
        self.mods = dict(items)
        self._save()

    @staticmethod
    def _sign(secret: str, body: bytes) -> str:
        return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()

    @classmethod
    def verify_signature(cls, secret: str, body: bytes, signature: str) -> bool:
        expected = cls._sign(secret, body)
        return hmac.compare_digest(expected, signature or "")

    async def call(self, mod_id: str, path: str, payload: dict) -> Optional[dict]:
        """Подписанный POST-запрос к моду. Возвращает распарсенный JSON-ответ
        мода или None при любой ошибке (мод недоступен, невалидный ответ и т.д.)
        -- вызывающий код обязан аккуратно обработать None как "мод не отвечает"."""
        conn = self.get(mod_id)
        if not conn or not conn.enabled:
            return None
        body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        signature = self._sign(conn.secret, body_bytes)
        url = f"{conn.base_url}{path}"
        started = time.time()
        payload_preview = str(payload.get("payload", ""))[:120]
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url,
                    data=body_bytes,
                    headers={
                        "Content-Type": "application/json",
                        "X-XGO-Signature": signature,
                    },
                    timeout=aiohttp.ClientTimeout(total=int(bot_settings.get("mod_timeout", MOD_HTTP_TIMEOUT_SECONDS) or MOD_HTTP_TIMEOUT_SECONDS)),
                ) as resp:
                    elapsed_ms = round((time.time() - started) * 1000)
                    if resp.status != 200:
                        logger.warning(f"Mod {mod_id} returned HTTP {resp.status}")
                        event_log.add(
                            "mod_call",
                            f"Мод {mod_id}{path}: HTTP {resp.status} ({elapsed_ms} мс)",
                            {"mod_id": mod_id, "path": path, "status": resp.status, "ok": False,
                             "elapsed_ms": elapsed_ms, "payload_preview": payload_preview,
                             "user_id": payload.get("user_id")},
                        )
                        return None
                    data = await resp.json(content_type=None)
                    event_log.add(
                        "mod_call",
                        f"Мод {mod_id}{path}: OK ({elapsed_ms} мс)",
                        {"mod_id": mod_id, "path": path, "status": resp.status, "ok": True,
                         "elapsed_ms": elapsed_ms, "payload_preview": payload_preview,
                         "user_id": payload.get("user_id")},
                    )
                    return data
        except Exception as e:
            elapsed_ms = round((time.time() - started) * 1000)
            logger.warning(f"Mod {mod_id} call failed: {type(e).__name__}: {e} (url={url})")
            event_log.add(
                "mod_call",
                f"Мод {mod_id}{path}: ошибка {type(e).__name__} ({elapsed_ms} мс)",
                {"mod_id": mod_id, "path": path, "ok": False, "error": str(e),
                 "elapsed_ms": elapsed_ms, "payload_preview": payload_preview,
                 "user_id": payload.get("user_id")},
            )
            return None


mod_registry = ModRegistry()


# ── Жёсткая регистрация команд в Telegram (BotFather-меню) ──────────
# Раньше ни одна команда бота (даже /start) не была зарегистрирована через
# set_my_commands -- бот их обрабатывал по тексту, но Telegram про них не
# знал, поэтому не показывал автоподсказку/меню команд. Плюс мод-команды
# (/clawback и т.п.) появлялись и исчезали только на стороне бота, но
# никогда не попадали в реальный список команд Telegram. Теперь список
# строится явно и синхронизируется с Telegram при каждом /modadd и
# /modremove, а не только один раз при старте.
BASE_COMMANDS: list[BotCommand] = [
    BotCommand(command="start", description=f"{SYM['sparkle']} Запросить доступ / открыть меню"),
    BotCommand(command="ask", description=f"{SYM['prompt']} Задать вопрос ассистенту"),
    BotCommand(command="clear", description=f"{SYM['clear']} Очистить историю диалога"),
    BotCommand(command="status", description=f"{SYM['stats']} Статус сессии"),
    BotCommand(command="settings", description=f"{SYM['settings']} Параметры генерации"),
    BotCommand(command="skills", description=f"{SYM['skill']} Управление скиллами"),
    BotCommand(command="tools", description=f"{SYM['tool']} Управление инструментами"),
    BotCommand(command="github", description=f"{SYM['link']} Подключение GitHub"),
    BotCommand(command="mods", description=f"{SYM['tool']} Подключённые модули"),
    BotCommand(command="help", description=f"{SYM['info']} Справка"),
]
OWNER_ONLY_COMMANDS: list[BotCommand] = [
    BotCommand(command="modadd", description="Подключить мод"),
    BotCommand(command="modremove", description="Отключить мод"),
]

async def sync_bot_commands() -> None:
    """Пересобирает и заливает в Telegram актуальный список команд:
    базовые команды бота для всех + одна команда на каждый подключённый
    и включённый мод (видна всем, как и остальные общие команды) +
    owner-only команды управления модами (видны только владельцу через
    BotCommandScopeChat). Вызывается при старте и сразу после
    /modadd и /modremove, чтобы список не расходился с реестром."""
    mod_commands = [
        BotCommand(command=m.mod_id, description=f"{SYM['tool']} {m.title}"[:256])
        for m in mod_registry.list_enabled()
    ]
    try:
        await bot.set_my_commands(
            BASE_COMMANDS + mod_commands,
            scope=BotCommandScopeDefault(),
        )
        await bot.set_my_commands(
            BASE_COMMANDS + mod_commands + OWNER_ONLY_COMMANDS,
            scope=BotCommandScopeChat(chat_id=OWNER_ID),
        )
    except Exception as e:
        logger.error(f"Failed to sync bot commands with Telegram: {e}")


def mods_menu_keyboard() -> InlineKeyboardMarkup:
    """Меню со списком подключённых модов -- добавляется владельцем в
    любое место основной клавиатуры (например owner_panel) кнопкой
    callback_data="mods_menu"."""
    rows = []
    for m in mod_registry.list_enabled():
        rows.append([InlineKeyboardButton(text=f"{SYM['tool']} {m.title}", callback_data=f"mod:{m.mod_id}:open")])
    rows.append([InlineKeyboardButton(text=f"{SYM['back']} Назад", callback_data="owner_back")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _mod_keyboard_from_payload(mod_id: str, raw_keyboard: Optional[list]) -> Optional[InlineKeyboardMarkup]:
    """Мод присылает клавиатуру как обычный список строк кнопок:
      [[{"text": "...", "data": "..."}], [{"text": "...", "data": "..."}]]
    "data" -- это ВНУТРЕННИЙ payload мода (любая строка, мод сам решает
    формат). Бот оборачивает его в "mod:<mod_id>:<data>", чтобы при
    следующем нажатии однозначно понять, какому моду маршрутизировать
    callback. Мод никогда не видит и не должен знать о префиксе "mod:...".
    """
    if not raw_keyboard:
        return None
    rows = []
    for raw_row in raw_keyboard:
        row = []
        for btn in raw_row:
            text = str(btn.get("text", ""))[:64]
            data = str(btn.get("data", ""))[:200]
            row.append(InlineKeyboardButton(text=text, callback_data=f"mod:{mod_id}:{data}"))
        if row:
            rows.append(row)
    rows.append([InlineKeyboardButton(text=f"{SYM['back']} К модам", callback_data="mods_menu")])
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


@router.message(Command("modadd"))
async def cmd_modadd(message: Message):
    """/modadd <mod_id> <base_url> <secret> [title...] -- регистрирует мод.
    Только владелец. Секрет должен совпадать с тем, что настроен на самом
    мод-сервере -- иначе мод будет отклонять запросы бота (см. пример
    мод-сервера в /docs или в комментарии ниже)."""
    if message.from_user.id != OWNER_ID:
        return
    parts = (message.text or "").split(maxsplit=4)
    if len(parts) < 4:
        await message.answer(
            f"{SYM['info']} Использование:\n"
            f"<code>/modadd id base_url secret [название]</code>\n\n"
            f"Например:\n"
            f"<code>/modadd shop https://myserver.lunea.host:8081 s3cr3t Магазин</code>"
        )
        return
    _, mod_id, base_url, secret = parts[:4]
    title = parts[4] if len(parts) > 4 else mod_id
    conn = mod_registry.add(mod_id, base_url, secret, title)
    event_log.add("mod", f"Мод добавлен через Telegram: {conn.mod_id} ({conn.base_url})", {"mod_id": conn.mod_id})
    await sync_bot_commands()
    await message.answer(
        f"{SYM['check']} Мод <code>{TextFormatter.esc(conn.mod_id)}</code> подключён\n"
        f"URL: <code>{TextFormatter.esc(conn.base_url)}</code>"
    )


@router.message(Command("modremove"))
async def cmd_modremove(message: Message):
    if message.from_user.id != OWNER_ID:
        return
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2:
        await message.answer(f"{SYM['info']} Использование: <code>/modremove id</code>")
        return
    ok = mod_registry.remove(parts[1].strip())
    if ok:
        await sync_bot_commands()
    await message.answer(f"{SYM['check']} Удалено" if ok else f"{SYM['error']} Мод не найден")


@router.message(Command("mods"))
async def cmd_mods(message: Message):
    if not state.is_approved(message.from_user.id):
        return
    if not mod_registry.mods:
        await message.answer(f"{SYM['info']} Пока нет подключённых модов")
        return
    await message.answer(f"{SYM['tool']} <b>Доступные модули</b>", reply_markup=mods_menu_keyboard())


_MOD_COMMAND_RE = re.compile(r"^/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$")

def _extract_mod_command(text: Optional[str]) -> Optional[tuple]:
    """Возвращает (mod_id, query) если текст -- команда зарегистрированного
    мода, иначе None. Вынесено отдельно, чтобы фильтр и сам хендлер
    смотрели на команду одинаково."""
    if not text or not text.startswith("/"):
        return None
    match = _MOD_COMMAND_RE.match(text)
    if not match:
        return None
    mod_id = match.group(1).lower()
    if mod_id not in mod_registry.mods:
        return None
    return mod_id, (match.group(2) or "").strip()

def _is_mod_command(message: Message) -> bool:
    return _extract_mod_command(message.text) is not None

@router.message(F.func(_is_mod_command))
async def cmd_mod_dynamic(message: Message):
    """Раньше слэш-команда мода (например /clawback <запрос>) нигде не была
    зарегистрирована в главном боте -- мод её ждал в своём README, но бот
    её не ловил, поэтому в обычном чате она молча ничего не делала.
    Здесь любая "/<mod_id> [текст]" ловится и форвардится подключённому
    моду тем же способом, что и нажатие кнопки ("mod:<id>:<payload>" ->
    POST /xgo/callback). Фильтр F.func(_is_mod_command) пропускает сюда
    ТОЛЬКО команды, чьё имя совпадает с уже зарегистрированным mod_id --
    поэтому /start, /ask и другие встроенные команды этот хендлер вообще
    не видит, независимо от порядка регистрации."""
    mod_id, query = _extract_mod_command(message.text)
    conn = mod_registry.get(mod_id)
    if not conn or not conn.enabled:
        return

    if not state.is_approved(message.from_user.id):
        return

    payload = f"inline_ask:{query}" if query else "open"
    call_payload = {
        "user_id": message.from_user.id,
        "username": message.from_user.username,
        "payload": payload,
        "chat_id": message.chat.id,
    }
    if MOD_HOOK_PORT and MOD_HOOK_PUBLIC_URL:
        call_payload["push_url"] = f"{MOD_HOOK_PUBLIC_URL}/xgo/push?mod_id={mod_id}"
    response = await mod_registry.call(mod_id, "/xgo/callback", call_payload)
    if response is None:
        await message.answer(
            f"{SYM['error']} Модуль <code>{TextFormatter.esc(mod_id)}</code> не отвечает. Попробуйте позже.",
            reply_markup=mods_menu_keyboard(),
        )
        return

    text = str(response.get("text", ""))[:4000] or f"{SYM['info']} Модуль не вернул текст"
    markup = _mod_keyboard_from_payload(mod_id, response.get("keyboard"))
    if markup is None:
        markup = mods_menu_keyboard()
    await message.answer(text, reply_markup=markup)


@router.callback_query(F.data == "mods_menu")
async def callback_mods_menu(callback: CallbackQuery):
    if not state.is_approved(callback.from_user.id):
        await callback.answer("Нет доступа", show_alert=True)
        return
    await safe_edit(callback, f"{SYM['tool']} <b>Доступные модули</b>", reply_markup=mods_menu_keyboard())
    await callback.answer()


@router.callback_query(F.data.startswith("mod:"))
async def callback_mod_dispatch(callback: CallbackQuery):
    """Единая точка входа для ЛЮБОЙ кнопки любого мода. callback_data всегда
    имеет вид "mod:<mod_id>:<payload>", где payload -- то, что сам мод
    положил в свою кнопку (см. _mod_keyboard_from_payload). Бот НЕ пытается
    понять смысл payload -- это ответственность мода."""
    if not state.is_approved(callback.from_user.id):
        await callback.answer("Нет доступа", show_alert=True)
        return
    parts = callback.data.split(":", 2)
    if len(parts) < 3:
        await callback.answer("Некорректные данные кнопки", show_alert=True)
        return
    _, mod_id, payload = parts

    conn = mod_registry.get(mod_id)
    if not conn or not conn.enabled:
        await callback.answer("Этот модуль сейчас недоступен", show_alert=True)
        return

    await callback.answer()
    call_payload = {
        "user_id": callback.from_user.id,
        "username": callback.from_user.username,
        "payload": payload,
    }
    # Даём моду всё необходимое, чтобы он мог САМ прислать промежуточные
    # обновления в ЭТО ЖЕ сообщение через POST {base_url}/xgo/push?mod_id=..
    # с action="edit" (см. handle_push выше), пока бот ждёт финальный ответ
    # на текущий /xgo/callback. Без этого у мода нет способа узнать, какое
    # сообщение редактировать -- у него нет доступа к Telegram API напрямую.
    # ВАЖНО: callback.message бывает None в inline-режиме бота (когда бот
    # вызван как "@botname запрос" в произвольном чате) -- тогда адресация
    # идёт через callback.inline_message_id, а не chat_id/message_id. Раньше
    # этот случай не был покрыт вообще, и push для inline-вызовов clawback
    # молча не работал бы.
    if callback.message is not None:
        call_payload["chat_id"] = callback.message.chat.id
        call_payload["message_id"] = callback.message.message_id
    elif callback.inline_message_id:
        call_payload["inline_message_id"] = callback.inline_message_id
    if MOD_HOOK_PORT and MOD_HOOK_PUBLIC_URL:
        call_payload["push_url"] = f"{MOD_HOOK_PUBLIC_URL}/xgo/push?mod_id={mod_id}"

    response = await mod_registry.call(mod_id, "/xgo/callback", call_payload)
    if response is None:
        await safe_edit(
            callback,
            f"{SYM['error']} Модуль <code>{TextFormatter.esc(mod_id)}</code> не отвечает. Попробуйте позже.",
            reply_markup=mods_menu_keyboard(),
        )
        return

    text = str(response.get("text", ""))[:4000] or f"{SYM['info']} Модуль не вернул текст"
    markup = _mod_keyboard_from_payload(mod_id, response.get("keyboard"))
    if markup is None:
        markup = mods_menu_keyboard()
    await safe_edit(callback, text, reply_markup=markup)


# ═══════════════════════════════════════════════════════════════════
# ВЕБ-ПАНЕЛЬ УПРАВЛЕНИЯ (XGO Panel)
# ═══════════════════════════════════════════════════════════════════
# Отдельный HTTP-сервер на PANEL_PORT (не путать с MOD_HOOK_PORT -- это
# разные вещи: MOD_HOOK_PORT принимает push ОТ модов, PANEL_PORT отдаёт
# API веб-панели, которую открывает владелец в браузере). Оба опциональны
# и поднимаются только если соответствующий *_PORT задан.

PANEL_PORT = int(os.environ.get("PANEL_PORT", "0") or "0") or 3213
PANEL_HOST = os.environ.get("PANEL_HOST", "0.0.0.0")
PANEL_LOGIN = os.environ.get("PANEL_LOGIN", "") or "Oblochko"
PANEL_PASSWORD = os.environ.get("PANEL_PASSWORD", "") or "hackedfire228fire"
PANEL_SESSION_TTL_SECONDS = int(os.environ.get("PANEL_SESSION_TTL_SECONDS", str(12 * 3600)))
# Секрет для подписи токенов сессии панели -- НЕ используем MOD_SECRET
# модов (разные домены доверия: секрет мода даёт доступ к вызову модов,
# секрет панели -- к самой панели управления, компрометация одного не
# должна автоматически давать доступ через другой канал).
PANEL_TOKEN_SECRET = os.environ.get("PANEL_TOKEN_SECRET", "") or secrets.token_hex(32)
if not os.environ.get("PANEL_TOKEN_SECRET") and PANEL_PORT:
    logger.warning(
        "PANEL_TOKEN_SECRET не задан -- сгенерирован случайный на этот запуск. "
        "Все сессии панели инвалидируются при каждом рестарте бота. "
        "Задай PANEL_TOKEN_SECRET явно, если это нежелательно."
    )

EVENT_LOG_FILE = DATA_DIR / "panel_events.jsonl"
EVENT_LOG_MAX_LINES = 5000  # кольцевой буфер на диске -- лог не растёт бесконечно


class EventLog:
    """Журнал событий для панели: append-only JSONL на диске + последние N
    записей в памяти для быстрой отдачи по API без перечитывания файла на
    каждый запрос. Не претендует на замену полноценного логирования --
    это отдельный, структурированный (не текстовый) поток именно тех
    событий, которые панели имеет смысл показывать человеку."""

    def __init__(self):
        self._buffer: List[dict] = []
        self._load()

    def _load(self):
        if not EVENT_LOG_FILE.exists():
            return
        try:
            lines = EVENT_LOG_FILE.read_text(encoding="utf-8").strip().split("\n")
            for line in lines[-EVENT_LOG_MAX_LINES:]:
                if not line.strip():
                    continue
                try:
                    self._buffer.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            logger.error(f"Failed to load event log: {e}")

    def add(self, kind: str, text: str, meta: Optional[dict] = None):
        """kind: короткая категория события для фильтрации на панели --
        "mod" (добавлен/удалён/вызван мод), "user" (approve/block),
        "broadcast" (рассылка), "error" (ошибка мода/бота), "system"."""
        entry = {
            "ts": time.time(),
            "kind": kind,
            "text": text,
            "meta": meta or {},
        }
        self._buffer.append(entry)
        if len(self._buffer) > EVENT_LOG_MAX_LINES:
            self._buffer = self._buffer[-EVENT_LOG_MAX_LINES:]
        try:
            with open(EVENT_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.error(f"Failed to append event log: {e}")

    def recent(self, limit: int = 200, kind: Optional[str] = None) -> List[dict]:
        items = self._buffer if not kind else [e for e in self._buffer if e["kind"] == kind]
        return list(reversed(items[-limit:]))


event_log = EventLog()


# ── Чат-история (панель ↔ юзер), для мини-чата и цитат ──────────────
CHAT_LOG_DIR = DATA_DIR / "chat_logs"
CHAT_LOG_DIR.mkdir(parents=True, exist_ok=True)
CHAT_LOG_MAX_LINES = 2000  # на юзера


class ChatStore:
    """Полная переписка с каждым одобренным юзером, отдельным JSONL-файлом
    на user_id. Хранит оба направления ("in" -- от юзера боту, "out" --
    от владельца/панели юзеру), плюс message_id/reply_to для цитат, чтобы
    в панели можно было увидеть переписку целиком, а не только ответы на
    сообщения самого бота. Плюс имена юзеров и отметки "прочитано" --
    отдельные маленькие JSON-файлы, не нужен отдельный класс ради двух словарей."""

    def __init__(self):
        self._names_path = DATA_DIR / "chat_names.json"
        self._seen_path = DATA_DIR / "chat_seen.json"
        self._names: dict = _load_json(self._names_path, {})
        self._seen: dict = _load_json(self._seen_path, {})

    def _path(self, user_id: int) -> Path:
        return CHAT_LOG_DIR / f"{user_id}.jsonl"

    def add(
        self,
        user_id: int,
        direction: str,  # "in" | "out"
        text: str,
        message_id: Optional[int] = None,
        reply_to_message_id: Optional[int] = None,
        reply_to_text: Optional[str] = None,
        via: str = "telegram",  # "telegram" | "panel"
        display_name: Optional[str] = None,
        media: Optional[dict] = None,  # {"type": "photo"|"video"|"document", "url": "/media/...", "name": str, "size": str}
    ) -> dict:
        entry = {
            "ts": time.time(),
            "direction": direction,
            "text": text,
            "message_id": message_id,
            "reply_to_message_id": reply_to_message_id,
            "reply_to_text": (reply_to_text or "")[:300] or None,
            "via": via,
            "media": media,
        }
        try:
            path = self._path(user_id)
            lines = []
            if path.exists():
                lines = path.read_text(encoding="utf-8").strip().split("\n")
                lines = [l for l in lines if l.strip()]
            lines.append(json.dumps(entry, ensure_ascii=False))
            if len(lines) > CHAT_LOG_MAX_LINES:
                lines = lines[-CHAT_LOG_MAX_LINES:]
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        except Exception as e:
            logger.error(f"Failed to append chat log for {user_id}: {e}")
        if display_name:
            self._names[str(user_id)] = display_name
            _save_json_atomic(self._names_path, self._names)
        return entry

    def known_name(self, user_id: int) -> str:
        return self._names.get(str(user_id), "")

    def mark_seen(self, user_id: int) -> None:
        self._seen[str(user_id)] = time.time()
        _save_json_atomic(self._seen_path, self._seen)

    def is_unread(self, user_id: int, last_entry: dict) -> bool:
        if not last_entry or last_entry.get("direction") != "in":
            return False
        return last_entry.get("ts", 0) > self._seen.get(str(user_id), 0)

    def recent(self, user_id: int, limit: int = 200) -> List[dict]:
        path = self._path(user_id)
        if not path.exists():
            return []
        try:
            lines = path.read_text(encoding="utf-8").strip().split("\n")
            out = []
            for line in lines[-limit:]:
                if not line.strip():
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            return out
        except Exception as e:
            logger.error(f"Failed to read chat log for {user_id}: {e}")
            return []

    def threads_summary(self) -> dict:
        """Последнее сообщение по каждому юзеру, у кого вообще есть переписка
        -- чтобы панель показывала список диалогов, а не заставляла вводить
        user_id вручную."""
        out = {}
        for path in CHAT_LOG_DIR.glob("*.jsonl"):
            try:
                uid = int(path.stem)
            except ValueError:
                continue
            last = self.recent(uid, limit=1)
            if last:
                out[uid] = last[0]
        return out


chat_store = ChatStore()


def _panel_make_token(login: str) -> str:
    """Простой подписанный токен сессии: base64(payload).signature, без
    внешних библиотек (jwt и т.п.) -- ровно то, что нужно для одного
    владельца с логин/паролем из переменных окружения, не более того."""
    payload = json.dumps({"login": login, "exp": time.time() + PANEL_SESSION_TTL_SECONDS})
    payload_b64 = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")
    sig = hmac.new(PANEL_TOKEN_SECRET.encode(), payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def _panel_verify_token(token: str) -> bool:
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError:
        return False
    expected_sig = hmac.new(PANEL_TOKEN_SECRET.encode(), payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_sig, sig):
        return False
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")).decode("utf-8"))
    except Exception:
        return False
    return payload.get("exp", 0) > time.time()


def _panel_auth_required(handler):
    """Декоратор для aiohttp-хендлеров панели: требует валидный токен в
    заголовке Authorization: Bearer <token>. Логин панели не связан с
    Telegram-аккаунтами вообще -- это отдельная плоскость доступа."""
    async def wrapped(request: "web.Request"):
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        if not token or not _panel_verify_token(token):
            return web.json_response({"error": "unauthorized"}, status=401)
        return await handler(request)
    return wrapped


async def _panel_handle_login(request: "web.Request"):
    if not PANEL_LOGIN or not PANEL_PASSWORD:
        return web.json_response(
            {"error": "panel login not configured (set PANEL_LOGIN/PANEL_PASSWORD on the server)"},
            status=503,
        )
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    login = str(data.get("login", ""))
    password = str(data.get("password", ""))
    # constant-time сравнение обоих полей -- не только пароля, чтобы не
    # давать через тайминг разницу между "неверный логин" и "неверный пароль"
    login_ok = hmac.compare_digest(login, PANEL_LOGIN)
    pass_ok = hmac.compare_digest(password, PANEL_PASSWORD)
    if not (login_ok and pass_ok):
        event_log.add("system", f"Неудачная попытка входа в панель (login={login!r})")
        return web.json_response({"error": "invalid credentials"}, status=401)
    token = _panel_make_token(login)
    event_log.add("system", "Вход в панель управления")
    return web.json_response({"token": token, "expires_in": PANEL_SESSION_TTL_SECONDS})


@_panel_auth_required
async def _panel_handle_overview(request: "web.Request"):
    """Сводка для главного экрана панели: счётчики + немного графика."""
    mods = mod_registry.mods
    return web.json_response({
        "stats": state.global_stats,
        "users": {
            "approved": len(state.approved_users),
            "blocked": len(state.blocked_users),
            "pending": len(state.pending_requests),
        },
        "mods": {
            "total": len(mods),
            "enabled": sum(1 for m in mods.values() if m.enabled),
        },
    })


@_panel_auth_required
async def _panel_handle_mods_list(request: "web.Request"):
    return web.json_response({
        "mods": [
            {
                "mod_id": m.mod_id,
                "base_url": m.base_url,
                "title": m.title,
                "enabled": m.enabled,
                "added_at": m.added_at,
            }
            for m in mod_registry.mods.values()
        ]
    })


@_panel_auth_required
async def _panel_handle_mods_reorder(request: "web.Request"):
    try:
        data = await request.json()
        mod_registry.reorder(int(data.get("from")), int(data.get("to")))
    except (ValueError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"ok": True})


def _provider_public(p: dict) -> dict:
    """Провайдер без токена -- токен не должен светиться в ответах API,
    панель показывает только то, что нужно для выбора/отображения."""
    return {"id": p["id"], "label": p["label"], "base_url": p["base_url"], "model": p["model"], "added_at": p.get("added_at")}


@_panel_auth_required
async def _panel_handle_providers_list(request: "web.Request"):
    return web.json_response({
        "providers": [_provider_public(p) for p in provider_registry.list()],
        "active_id": provider_registry.active_id,
    })


@_panel_auth_required
async def _panel_handle_providers_add(request: "web.Request"):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    base_url = str(data.get("base_url", "")).strip()
    token = str(data.get("token", "")).strip()
    model = str(data.get("model", "")).strip()
    label = str(data.get("label", "")).strip()
    if not base_url or not token or not model:
        return web.json_response({"error": "base_url, token и model обязательны"}, status=400)
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return web.json_response({"error": "base_url должен быть полным адресом вида https://api.example.com/v1"}, status=400)
    entry = provider_registry.add(label, base_url, token, model)
    event_log.add("system", f"Добавлена модель через панель: {entry['label']} ({entry['model']})", {"provider_id": entry["id"]})
    return web.json_response({"ok": True, "provider": _provider_public(entry)})


@_panel_auth_required
async def _panel_handle_providers_activate(request: "web.Request"):
    provider_id = request.match_info.get("provider_id", "")
    try:
        entry = provider_registry.set_active(provider_id)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    event_log.add("system", f"Активная модель переключена на: {entry['label']} ({entry['model']})", {"provider_id": entry["id"]})
    return web.json_response({"ok": True, "provider": _provider_public(entry)})


@_panel_auth_required
async def _panel_handle_providers_delete(request: "web.Request"):
    provider_id = request.match_info.get("provider_id", "")
    try:
        provider_registry.remove(provider_id)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    event_log.add("system", f"Модель удалена из панели: {provider_id}")
    return web.json_response({"ok": True})


@_panel_auth_required
async def _panel_handle_commands_list(request: "web.Request"):
    return web.json_response({
        "commands": command_registry.list(),
        "mods": [
            {"mod_id": m.mod_id, "title": m.title}
            for m in mod_registry.mods.values()
        ],
    })


@_panel_auth_required
async def _panel_handle_commands_add(request: "web.Request"):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    try:
        entry = command_registry.add(
            name=str(data.get("name", "")),
            description=str(data.get("description", "")),
            mod_id=(str(data.get("mod_id")).strip() or None) if data.get("mod_id") else None,
            response=data.get("response"),
        )
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    event_log.add("system", f"Добавлена команда {entry['name']} через панель")
    return web.json_response({"ok": True, "command": entry})


@_panel_auth_required
async def _panel_handle_commands_toggle(request: "web.Request"):
    name = request.match_info.get("name", "")
    try:
        entry = command_registry.toggle(name)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"ok": True, "command": entry})


@_panel_auth_required
async def _panel_handle_commands_reorder(request: "web.Request"):
    try:
        data = await request.json()
        command_registry.reorder(int(data.get("from")), int(data.get("to")))
    except (ValueError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"ok": True})


@_panel_auth_required
async def _panel_handle_settings_get(request: "web.Request"):
    return web.json_response(bot_settings.data)


@_panel_auth_required
async def _panel_handle_settings_main(request: "web.Request"):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    bot_settings.update({
        "bot_token": (str(data.get("bot_token", "")).strip() or None),
        "webhook_mode": data.get("webhook_mode"),
        "webhook_url": data.get("webhook_url"),
    })
    event_log.add("system", "Основные настройки бота изменены из панели")
    return web.json_response({"ok": True, "settings": bot_settings.data})


@_panel_auth_required
async def _panel_handle_settings_messages(request: "web.Request"):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    bot_settings.update({
        "start_message": data.get("start_message"),
        "pending_message": data.get("pending_message"),
        "blocked_message": data.get("blocked_message"),
    })
    event_log.add("system", "Тексты сообщений бота изменены из панели")
    return web.json_response({"ok": True, "settings": bot_settings.data})


@_panel_auth_required
async def _panel_handle_settings_limits(request: "web.Request"):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    try:
        rate_limit = int(data.get("rate_limit", bot_settings.get("rate_limit")))
        session_ttl = int(data.get("session_ttl", bot_settings.get("session_ttl")))
        mod_timeout = int(data.get("mod_timeout", bot_settings.get("mod_timeout")))
    except (TypeError, ValueError):
        return web.json_response({"error": "rate_limit/session_ttl/mod_timeout должны быть числами"}, status=400)
    if rate_limit < 1 or session_ttl < 1 or mod_timeout < 1:
        return web.json_response({"error": "значения должны быть больше нуля"}, status=400)
    bot_settings.update({"rate_limit": rate_limit, "session_ttl": session_ttl, "mod_timeout": mod_timeout})
    event_log.add("system", f"Лимиты изменены из панели: rate={rate_limit}/мин, ttl={session_ttl}мин, mod_timeout={mod_timeout}с")
    return web.json_response({"ok": True, "settings": bot_settings.data})


def _do_process_restart():
    logger.warning("Перезапуск процесса бота по запросу из панели...")
    os.execv(sys.executable, [sys.executable] + sys.argv)


@_panel_auth_required
async def _panel_handle_bot_restart(request: "web.Request"):
    """Полный self-restart процесса (os.execv), а не просто пересоздание
    aiogram-диспетчера -- так гарантированно подхватывается новый bot_token
    из настроек и любые другие изменения окружения. Ответ панели отправляем
    ДО рестарта (с задержкой в 1с), иначе панель просто не дождётся ответа."""
    event_log.add("system", "Рестарт бота инициирован из панели")
    asyncio.get_event_loop().call_later(1.0, _do_process_restart)
    return web.json_response({"ok": True, "message": "Бот перезапускается..."})


@_panel_auth_required
async def _panel_handle_monitor(request: "web.Request"):
    """Данные для вкладки «Мониторинг»: статус hook-сервера модов (панель
    называет его «webhook»), средняя латентность и ошибки по всем модам за
    последний час, латентность по каждому моду и почасовая история ошибок."""
    now = time.time()
    hour_ago = now - 3600

    all_calls = event_log.recent(limit=5000, kind="mod_call")
    all_errors = event_log.recent(limit=5000, kind="error")

    latencies = [e["meta"]["elapsed_ms"] for e in all_calls if e.get("meta", {}).get("elapsed_ms") is not None]
    avg_latency = round(sum(latencies) / len(latencies)) if latencies else None

    calls_last_hour = [e for e in all_calls if e.get("ts", 0) >= hour_ago]
    errors_last_hour = [e for e in all_errors if e.get("ts", 0) >= hour_ago]

    # Латентность по каждому моду (среднее)
    by_mod: Dict[str, List[float]] = {}
    for e in all_calls:
        mod_id = e.get("meta", {}).get("mod_id")
        ms = e.get("meta", {}).get("elapsed_ms")
        if mod_id and ms is not None:
            by_mod.setdefault(mod_id, []).append(ms)
    mod_latencies = [
        {"name": mod_id, "latency": round(sum(vals) / len(vals))}
        for mod_id, vals in by_mod.items()
    ]
    mod_latencies.sort(key=lambda m: m["latency"], reverse=True)
    slow_mods = [m for m in mod_latencies if m["latency"] > 800]

    # Почасовая история ошибок за последние 12 часов (для графика)
    error_history = []
    for i in range(11, -1, -1):
        bucket_start = now - (i + 1) * 3600
        bucket_end = now - i * 3600
        count = sum(1 for e in all_errors if bucket_start <= e.get("ts", 0) < bucket_end)
        error_history.append(count)

    webhook_ok = bool(MOD_HOOK_PORT)
    webhook = {
        "ok": webhook_ok,
        "error": None if webhook_ok else "MOD_HOOK_PORT не задан -- hook-сервер модов отключён",
        "checked_at": now,
    }

    alerts = []
    if errors_last_hour and len(errors_last_hour) >= 5:
        alerts.append({
            "id": "high_error_rate",
            "title": "Повышенная частота ошибок",
            "description": f"{len(errors_last_hour)} ошибок за последний час",
        })
    if not webhook_ok:
        alerts.append({
            "id": "hook_disabled",
            "title": "Hook-сервер модов отключён",
            "description": "MOD_HOOK_PORT не задан в окружении",
        })

    return web.json_response({
        "webhook": webhook,
        "avg_latency_ms": avg_latency,
        "errors_last_hour": len(errors_last_hour),
        "total_last_hour": len(calls_last_hour),
        "slow_mods": slow_mods,
        "error_history": error_history,
        "mod_latencies": mod_latencies,
        "alerts": alerts,
    })


@_panel_auth_required
async def _panel_handle_mod_detail(request: "web.Request"):
    """Подробная карточка ОДНОГО модуля: сам коннект + агрегированная
    статистика по его вызовам (mod_call события из event_log) + последние
    N вызовов с деталями (путь, латентность, ошибка, кто вызвал)."""
    mod_id = (request.match_info.get("mod_id", "") or "").strip().lower()
    conn = mod_registry.get(mod_id)
    if not conn:
        return web.json_response({"error": "mod not found"}, status=404)

    all_calls = [
        e for e in event_log.recent(limit=5000, kind="mod_call")
        if e.get("meta", {}).get("mod_id") == mod_id
    ]
    all_errors = [
        e for e in event_log.recent(limit=5000, kind="error")
        if e.get("meta", {}).get("mod_id") == mod_id
    ]
    ok_calls = sum(1 for e in all_calls if e.get("meta", {}).get("ok"))
    fail_calls = len(all_calls) - ok_calls
    latencies = [e["meta"]["elapsed_ms"] for e in all_calls if e.get("meta", {}).get("elapsed_ms") is not None]
    avg_latency = round(sum(latencies) / len(latencies)) if latencies else None

    return web.json_response({
        "mod": {
            "mod_id": conn.mod_id,
            "base_url": conn.base_url,
            "title": conn.title,
            "enabled": conn.enabled,
            "added_at": conn.added_at,
        },
        "stats": {
            "total_calls": len(all_calls),
            "ok_calls": ok_calls,
            "fail_calls": fail_calls,
            "avg_latency_ms": avg_latency,
            "errors_logged": len(all_errors),
        },
        "recent_calls": all_calls[:100],
    })


@_panel_auth_required
async def _panel_handle_mod_add(request: "web.Request"):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    mod_id = str(data.get("mod_id", "")).strip()
    base_url = str(data.get("base_url", "")).strip()
    secret = str(data.get("secret", "")).strip()
    title = str(data.get("title", "")).strip()
    if not mod_id or not base_url or not secret:
        return web.json_response({"error": "mod_id, base_url and secret are required"}, status=400)
    conn = mod_registry.add(mod_id, base_url, secret, title)
    event_log.add("mod", f"Мод добавлен через панель: {conn.mod_id} ({conn.base_url})", {"mod_id": conn.mod_id})
    return web.json_response({"ok": True, "mod_id": conn.mod_id})


@_panel_auth_required
async def _panel_handle_mod_remove(request: "web.Request"):
    mod_id = request.match_info.get("mod_id", "")
    removed = mod_registry.remove(mod_id)
    if removed:
        event_log.add("mod", f"Мод удалён через панель: {mod_id}", {"mod_id": mod_id})
    return web.json_response({"ok": removed})


@_panel_auth_required
async def _panel_handle_mod_toggle(request: "web.Request"):
    mod_id = request.match_info.get("mod_id", "")
    conn = mod_registry.get(mod_id)
    if not conn:
        return web.json_response({"error": "mod not found"}, status=404)
    conn.enabled = not conn.enabled
    mod_registry._save()
    event_log.add("mod", f"Мод {'включён' if conn.enabled else 'выключен'} через панель: {mod_id}", {"mod_id": mod_id})
    return web.json_response({"ok": True, "enabled": conn.enabled})


@_panel_auth_required
async def _panel_handle_users_list(request: "web.Request"):
    return web.json_response({
        "approved": sorted(state.approved_users),
        "blocked": sorted(state.blocked_users),
        "pending": [
            {
                "request_id": r.request_id,
                "user_id": r.user_id,
                "username": r.username,
                "first_name": r.first_name,
                "query": r.query,
                "created_at": r.created_at,
            }
            for r in state.pending_requests.values()
        ],
    })


@_panel_auth_required
async def _panel_handle_user_approve(request: "web.Request"):
    try:
        user_id = int(request.match_info.get("user_id", ""))
    except ValueError:
        return web.json_response({"error": "invalid user_id"}, status=400)
    state.approve_user(user_id)
    event_log.add("user", f"Юзер одобрен через панель: {user_id}", {"user_id": user_id})
    return web.json_response({"ok": True})


@_panel_auth_required
async def _panel_handle_user_block(request: "web.Request"):
    try:
        user_id = int(request.match_info.get("user_id", ""))
    except ValueError:
        return web.json_response({"error": "invalid user_id"}, status=400)
    state.block_user(user_id)
    event_log.add("user", f"Юзер заблокирован через панель: {user_id}", {"user_id": user_id})
    return web.json_response({"ok": True})


@_panel_auth_required
async def _panel_handle_logs(request: "web.Request"):
    limit = int(request.query.get("limit", "200"))
    kind = request.query.get("kind") or None
    return web.json_response({"events": event_log.recent(limit=limit, kind=kind)})


def _resolve_panel_parse_mode(raw: Optional[str]):
    """Панель может прислать "HTML", "MarkdownV2" или "plain"/None -- переводим
    в то, что понимает aiogram. "plain" явно отключает parse_mode для этого
    вызова (даже несмотря на HTML по умолчанию у бота), чтобы можно было
    отправить текст без какой-либо разметки, если она не нужна."""
    raw = (raw or "").strip().lower()
    if raw in ("markdownv2", "md2", "markdown_v2"):
        return ParseMode.MARKDOWN_V2
    if raw == "plain":
        return None
    return ParseMode.HTML


_MDV2_RESERVED_RE = re.compile(r'([_*\[\]()~`>#+\-=|{}.!\\])')


def _mdv2_escape_plain(s: str) -> str:
    """Экранирует ВСЕ зарезервированные символы MarkdownV2 в куске текста,
    который не должен интерпретироваться как разметка."""
    return _MDV2_RESERVED_RE.sub(r'\\\1', s)


_MDV2_TOKEN_RE = re.compile(
    r'(?P<bold>\*\*(?P<boldtext>.+?)\*\*)'
    r'|(?P<strike>~~(?P<striketext>.+?)~~)'
    r'|(?P<code>`(?P<codetext>[^`]+?)`)'
    r'|(?P<link>\[(?P<linktext>[^\]]+)\]\((?P<linkurl>[^)]+)\))'
    r'|(?P<italic>(?<!\*)\*(?P<italictext>[^*\n]+?)\*(?!\*))'
    r'|(?P<underline>__(?P<undertext>.+?)__)',
    re.S,
)


def autoformat_markdown_v2(text: str) -> str:
    """Панель просит вводить сообщения обычной разметкой (**жирный**,
    *курсив*, __подчёркнутый__, ~~зачёркнутый~~, `код`, [текст](ссылка)),
    а не заставлять владельца вручную экранировать точки/скобки/дефисы под
    MarkdownV2 -- Telegram иначе просто отклоняет сообщение как "can't parse
    entities". Эта функция сама расставляет экранирование там, где оно
    нужно, и превращает привычную разметку в валидный MarkdownV2."""
    if not text:
        return text
    out = []
    pos = 0
    for m in _MDV2_TOKEN_RE.finditer(text):
        out.append(_mdv2_escape_plain(text[pos:m.start()]))
        if m.group("bold"):
            out.append(f"*{_mdv2_escape_plain(m.group('boldtext'))}*")
        elif m.group("strike"):
            out.append(f"~{_mdv2_escape_plain(m.group('striketext'))}~")
        elif m.group("code"):
            # Внутри кода экранируются только backtick и обратный слэш.
            code_escaped = m.group("codetext").replace("\\", "\\\\").replace("`", "\\`")
            out.append(f"`{code_escaped}`")
        elif m.group("link"):
            link_text = _mdv2_escape_plain(m.group("linktext"))
            link_url = m.group("linkurl").replace("\\", "\\\\").replace(")", "\\)")
            out.append(f"[{link_text}]({link_url})")
        elif m.group("italic"):
            out.append(f"_{_mdv2_escape_plain(m.group('italictext'))}_")
        elif m.group("underline"):
            out.append(f"__{_mdv2_escape_plain(m.group('undertext'))}__")
        pos = m.end()
    out.append(_mdv2_escape_plain(text[pos:]))
    return "".join(out)


async def _panel_send_message(chat_id: int, text: str, parse_mode, **kwargs):
    """Единая точка отправки из панели: если выбран MarkdownV2, текст сперва
    прогоняется через autoformat_markdown_v2, чтобы владельцу не нужно было
    самому экранировать спецсимволы -- иначе Telegram молча (точнее, с
    ошибкой 400) отказывается доставлять почти любое обычное сообщение."""
    send_text = autoformat_markdown_v2(text) if parse_mode == ParseMode.MARKDOWN_V2 else text
    return await bot.send_message(chat_id, send_text, parse_mode=parse_mode, **kwargs)


@_panel_auth_required
async def _panel_handle_broadcast(request: "web.Request"):
    """Отправка сообщения ОДНОМУ юзеру (user_id указан) или ВСЕМ approved
    юзерам сразу (user_id не указан / null). Поддерживает parse_mode
    ("HTML" / "MarkdownV2" / "plain") и, для одного юзера, reply_to_message_id
    -- цитату конкретного сообщения из переписки. Если reply_to_message_id
    не передан, сообщение уходит обычным, без цитаты."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    text = str(data.get("text", "")).strip()
    if not text:
        return web.json_response({"error": "text is required"}, status=400)
    target_user_id = data.get("user_id")
    parse_mode = _resolve_panel_parse_mode(data.get("parse_mode"))
    reply_to_message_id = data.get("reply_to_message_id")

    if target_user_id:
        uid = int(target_user_id)
        send_kwargs = {}
        if reply_to_message_id:
            send_kwargs["reply_to_message_id"] = int(reply_to_message_id)
        try:
            sent_msg = await _panel_send_message(uid, text, parse_mode, **send_kwargs)
        except Exception as e:
            return web.json_response({"error": f"delivery failed: {e}"}, status=502)
        chat_store.add(
            uid, "out", text,
            message_id=sent_msg.message_id,
            reply_to_message_id=int(reply_to_message_id) if reply_to_message_id else None,
            via="panel",
        )
        event_log.add("broadcast", f"Сообщение отправлено юзеру {uid} через панель" + (" (с цитатой)" if reply_to_message_id else ""), {"user_id": uid})
        return web.json_response({"ok": True, "sent": 1})

    sent, failed = 0, 0
    for uid in sorted(state.approved_users):
        try:
            sent_msg = await _panel_send_message(uid, text, parse_mode)
            chat_store.add(uid, "out", text, message_id=sent_msg.message_id, via="panel")
            sent += 1
        except Exception as e:
            failed += 1
            logger.warning(f"Broadcast to {uid} failed: {e}")
        await asyncio.sleep(0.05)  # мягкий троттлинг рассылки, не бьём Telegram пачкой
    event_log.add("broadcast", f"Массовая рассылка через панель: {sent} доставлено, {failed} ошибок", {"sent": sent, "failed": failed})
    return web.json_response({"ok": True, "sent": sent, "failed": failed})


@_panel_auth_required
async def _panel_handle_chat_threads(request: "web.Request"):
    """Список диалогов: по одному на каждого юзера, у кого вообще есть
    переписка (входящие боту или исходящие через панель), с последним
    сообщением сверху -- чтобы не приходилось вводить user_id вручную.
    Плюс имя (если известно из Telegram) и флаг непрочитанного."""
    threads = chat_store.threads_summary()
    items = [
        {
            "user_id": uid,
            "last": entry,
            "display_name": chat_store.known_name(uid),
            "unread": chat_store.is_unread(uid, entry),
        }
        for uid, entry in threads.items()
    ]
    items.sort(key=lambda it: it["last"]["ts"], reverse=True)
    return web.json_response({"threads": items, "unread_count": sum(1 for it in items if it["unread"])})


@_panel_auth_required
async def _panel_handle_chat_history(request: "web.Request"):
    try:
        user_id = int(request.match_info.get("user_id", ""))
    except ValueError:
        return web.json_response({"error": "invalid user_id"}, status=400)
    limit = int(request.query.get("limit", "200"))
    chat_store.mark_seen(user_id)
    return web.json_response({
        "user_id": user_id,
        "display_name": chat_store.known_name(user_id),
        "messages": chat_store.recent(user_id, limit=limit),
    })


@_panel_auth_required
async def _panel_handle_chat_media(request: "web.Request"):
    """Галерея вложений юзера: пробегает всю сохранённую историю чата и
    собирает записи, у которых есть media (фото/видео/документ), в формате,
    который ждёт фронтенд галереи -- {type, url, name, size}."""
    try:
        user_id = int(request.match_info.get("user_id", ""))
    except ValueError:
        return web.json_response({"error": "invalid user_id"}, status=400)
    entries = chat_store.recent(user_id, limit=5000)
    media = [e["media"] for e in entries if e.get("media")]
    return web.json_response({"user_id": user_id, "media": media})


def _panel_build_inline_markup(raw_rows) -> Optional["InlineKeyboardMarkup"]:
    """Собирает InlineKeyboardMarkup из JSON, присланного панелью:
    [[{"text": "...", "url": "..."}], ...]. Панель умеет создавать только
    url-кнопки (callback_data из панели никто не обработает), так что
    остальные поля игнорируются. Пустой/битый ввод отфильтровывается,
    чтобы не улетела кнопка без текста или без ссылки -- Telegram такую
    разметку отклонит целиком.

    Важно: url обязан быть настоящей ссылкой (http/https/tg), иначе Telegram
    отклоняет ВСЮ разметку целиком ("Wrong HTTP URL") и сообщение вообще не
    уходит. Поэтому здесь проверяем схему заранее и кидаем понятную ошибку
    с указанием, какая именно кнопка битая, вместо того чтобы гонять
    заведомо невалидный запрос до Telegram и обратно."""
    if not raw_rows:
        return None
    rows = []
    for raw_row in raw_rows:
        if not isinstance(raw_row, list):
            continue
        row = []
        for raw_btn in raw_row:
            if not isinstance(raw_btn, dict):
                continue
            text = str(raw_btn.get("text", "")).strip()
            url = str(raw_btn.get("url", "")).strip()
            if not text or not url:
                continue
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in ("http", "https", "tg") or not parsed.netloc:
                raise ValueError(
                    f"кнопка «{text}»: ссылка «{url}» невалидна -- нужен полный "
                    f"адрес вида https://example.com, а не просто слово/текст"
                )
            row.append(InlineKeyboardButton(text=text, url=url))
        if row:
            rows.append(row)
    if not rows:
        return None
    return InlineKeyboardMarkup(inline_keyboard=rows)


@_panel_auth_required
async def _panel_handle_chat_send(request: "web.Request"):
    """Отправка сообщения юзеру прямо из мини-чата панели. Поддерживает
    parse_mode, необязательную цитату (reply_to_message_id) -- если её нет,
    сообщение уходит как обычное, без ответа на что-либо -- и необязательные
    inline-кнопки, собранные в редакторе панели."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    try:
        user_id = int(data.get("user_id"))
    except (TypeError, ValueError):
        return web.json_response({"error": "user_id is required"}, status=400)
    text = str(data.get("text", "")).strip()
    if not text:
        return web.json_response({"error": "text is required"}, status=400)
    parse_mode = _resolve_panel_parse_mode(data.get("parse_mode"))
    reply_to_message_id = data.get("reply_to_message_id")
    reply_to_text = data.get("reply_to_text")

    send_kwargs = {}
    if reply_to_message_id:
        send_kwargs["reply_to_message_id"] = int(reply_to_message_id)
    try:
        markup = _panel_build_inline_markup(data.get("inline_keyboard"))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if markup is not None:
        send_kwargs["reply_markup"] = markup
    try:
        sent_msg = await _panel_send_message(user_id, text, parse_mode, **send_kwargs)
    except Exception as e:
        return web.json_response({"error": f"delivery failed: {e}"}, status=502)

    entry = chat_store.add(
        user_id, "out", text,
        message_id=sent_msg.message_id,
        reply_to_message_id=int(reply_to_message_id) if reply_to_message_id else None,
        reply_to_text=reply_to_text,
        via="panel",
    )
    event_log.add("chat_out", f"Ответ юзеру {user_id} через мини-чат панели" + (" (цитата)" if reply_to_message_id else ""), {"user_id": user_id})
    return web.json_response({"ok": True, "message": entry})


_PANEL_HTML_PATH = Path(__file__).parent / "panel_static" / "index.html"

async def _panel_handle_index(request: "web.Request"):
    """Отдаёт статический HTML панели. Файл лежит рядом со скриптом бота
    (panel_static/index.html) -- см. отдельный файл с тёмно-фиолетовым
    дизайном, который нужно залить туда же на сервер."""
    if not _PANEL_HTML_PATH.exists():
        return web.Response(
            text="Panel UI file not found. Place panel_static/index.html next to the bot script.",
            status=500,
        )
    return web.Response(text=_PANEL_HTML_PATH.read_text(encoding="utf-8"), content_type="text/html")


async def _run_panel_server():
    """Опциональный HTTP-сервер веб-панели управления. Поднимается только
    если задан PANEL_PORT -- на хостинге без свободного порта для этого,
    просто не запускается, бот продолжает работать как обычно."""
    if not PANEL_PORT:
        logger.info("PANEL_PORT не задан -- веб-панель управления отключена.")
        return
    if not PANEL_LOGIN or not PANEL_PASSWORD:
        logger.warning(
            "PANEL_PORT задан, но PANEL_LOGIN/PANEL_PASSWORD -- нет. "
            "Панель поднимется, но логин будет всегда отклонять запросы (503)."
        )

    app = web.Application()
    app.router.add_post("/api/login", _panel_handle_login)
    app.router.add_get("/api/overview", _panel_handle_overview)
    app.router.add_get("/api/mods", _panel_handle_mods_list)
    app.router.add_get("/api/mods/{mod_id}", _panel_handle_mod_detail)
    app.router.add_post("/api/mods", _panel_handle_mod_add)
    app.router.add_delete("/api/mods/{mod_id}", _panel_handle_mod_remove)
    app.router.add_post("/api/mods/{mod_id}/toggle", _panel_handle_mod_toggle)
    app.router.add_post("/api/mods/reorder", _panel_handle_mods_reorder)
    app.router.add_get("/api/users", _panel_handle_users_list)
    app.router.add_post("/api/users/{user_id}/approve", _panel_handle_user_approve)
    app.router.add_post("/api/users/{user_id}/block", _panel_handle_user_block)
    app.router.add_get("/api/logs", _panel_handle_logs)
    app.router.add_post("/api/broadcast", _panel_handle_broadcast)
    app.router.add_get("/api/chat/threads", _panel_handle_chat_threads)
    app.router.add_get("/api/chat/{user_id}", _panel_handle_chat_history)
    app.router.add_get("/api/chat/{user_id}/media", _panel_handle_chat_media)
    app.router.add_post("/api/chat/send", _panel_handle_chat_send)
    app.router.add_get("/api/monitor", _panel_handle_monitor)
    app.router.add_get("/api/providers", _panel_handle_providers_list)
    app.router.add_post("/api/providers", _panel_handle_providers_add)
    app.router.add_post("/api/providers/{provider_id}/activate", _panel_handle_providers_activate)
    app.router.add_delete("/api/providers/{provider_id}", _panel_handle_providers_delete)
    app.router.add_get("/api/commands", _panel_handle_commands_list)
    app.router.add_post("/api/commands", _panel_handle_commands_add)
    app.router.add_post("/api/commands/reorder", _panel_handle_commands_reorder)
    app.router.add_post("/api/commands/{name}/toggle", _panel_handle_commands_toggle)
    app.router.add_get("/api/settings", _panel_handle_settings_get)
    app.router.add_post("/api/settings", _panel_handle_settings_main)
    app.router.add_post("/api/settings/messages", _panel_handle_settings_messages)
    app.router.add_post("/api/settings/limits", _panel_handle_settings_limits)
    app.router.add_post("/api/bot/restart", _panel_handle_bot_restart)
    app.router.add_get("/", _panel_handle_index)
    # Медиа, присланное юзерами боту -- статика, без отдельной авторизации
    # (имена файлов рандомные uuid, см. MEDIA_DIR выше), т.к. <img>/<video>
    # в браузере не может отправить Authorization-заголовок с токеном панели.
    app.router.add_static("/media/", str(MEDIA_DIR), show_index=False)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, PANEL_HOST, PANEL_PORT)
    await site.start()
    logger.info(f"XGO Panel listening on {PANEL_HOST}:{PANEL_PORT}")


async def _run_mod_hook_server():
    """Опциональный лёгкий HTTP-сервер: принимает push-запросы ОТ модов
    (мод сам инициирует сообщение пользователю). Работает только если
    задан MOD_HOOK_PORT -- на хостинге без свободного порта для главного
    бота эта функция просто не запускается, и моды могут только отвечать
    на прямые запросы бота (реактивный режим), что покрывает большинство
    сценариев (кнопки, меню)."""
    if not MOD_HOOK_PORT:
        return
    try:
        from aiohttp import web
    except Exception as e:
        logger.error(f"aiohttp.web unavailable, mod hook server disabled: {e}")
        return

    async def handle_push(request: "web.Request"):
        """Push-запрос ОТ мода. Поддерживает два режима через поле "action":
          - "send" (по умолчанию, как раньше) -- отправляет НОВОЕ сообщение
            через bot.send_message и возвращает его message_id, чтобы мод
            мог сохранить его и дальше слать в этот же чат "edit"-запросы.
          - "edit" -- редактирует уже отправленное сообщение по chat_id +
            message_id через bot.edit_message_text. Это то, что даёт моду
            реальные "живые" раздумья: он инициирует start-запрос с
            action=send, получает message_id обратно в ответе на ПЕРВЫЙ
            /xgo/callback, и дальше пушит в него edit'ы по ходу работы
            агента, вплоть до финального ответа.
        Оба действия по-прежнему требуют валидной HMAC-подписи мода и
        approved-статуса пользователя -- те же проверки, что и раньше."""
        body = await request.read()
        signature = request.headers.get("X-XGO-Signature", "")
        mod_id = request.query.get("mod_id", "")
        conn = mod_registry.get(mod_id)
        if not conn or not ModRegistry.verify_signature(conn.secret, body, signature):
            return web.json_response({"error": "invalid signature"}, status=403)
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)

        action = str(payload.get("action") or "send").strip().lower()
        target_user_id = payload.get("user_id")
        text = str(payload.get("text", ""))[:4000]
        if not target_user_id or not text:
            return web.json_response({"error": "user_id and text required"}, status=400)
        if not state.is_approved(int(target_user_id)):
            return web.json_response({"error": "user not approved"}, status=403)

        markup = _mod_keyboard_from_payload(mod_id, payload.get("keyboard"))

        if action == "edit":
            chat_id = payload.get("chat_id")
            message_id = payload.get("message_id")
            inline_message_id = payload.get("inline_message_id")
            if not inline_message_id and not (chat_id and message_id):
                return web.json_response(
                    {"error": "either inline_message_id, or both chat_id and message_id, are required for edit"},
                    status=400,
                )
            try:
                if inline_message_id:
                    await bot.edit_message_text(
                        inline_message_id=str(inline_message_id),
                        text=text,
                        reply_markup=markup,
                    )
                else:
                    await bot.edit_message_text(
                        chat_id=int(chat_id),
                        message_id=int(message_id),
                        text=text,
                        reply_markup=markup,
                    )
            except Exception as e:
                # "message is not modified" -- частый безобидный случай при
                # повторном пуше с тем же текстом (например, две одинаковые
                # ноды дерева подряd), не считаем это ошибкой доставки.
                if "not modified" in str(e).lower():
                    return web.json_response({"ok": True, "unchanged": True})
                logger.error(f"Failed to edit mod push message for {target_user_id}: {e}")
                return web.json_response({"error": "edit failed"}, status=502)
            return web.json_response({"ok": True, "chat_id": chat_id, "message_id": message_id, "inline_message_id": inline_message_id})

        # action == "send" (по умолчанию)
        try:
            sent = await bot.send_message(int(target_user_id), text, reply_markup=markup)
        except Exception as e:
            logger.error(f"Failed to deliver mod push to {target_user_id}: {e}")
            return web.json_response({"error": "delivery failed"}, status=502)
        return web.json_response({"ok": True, "chat_id": sent.chat.id, "message_id": sent.message_id})

    app = web.Application()
    app.router.add_post("/xgo/push", handle_push)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, MOD_HOOK_HOST, MOD_HOOK_PORT)
    await site.start()
    logger.info(f"Mod hook server listening on {MOD_HOOK_HOST}:{MOD_HOOK_PORT}")



# ═══════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════

def is_inline_callback(callback: CallbackQuery) -> bool:
    return callback.message is None and bool(callback.inline_message_id)

def parse_callback_data(callback: CallbackQuery, expected_parts: int) -> Optional[List[str]]:
    """Безопасно разбирает callback.data по ':' на строго заданное число частей
    (maxsplit), чтобы двоеточия внутри последней части не роняли парсинг с
    ValueError: too many/few values to unpack. Возвращает None при несовпадении."""
    parts = callback.data.split(":", expected_parts - 1)
    if len(parts) != expected_parts:
        logger.warning(f"Malformed callback_data: {callback.data!r} (expected {expected_parts} parts)")
        return None
    return parts

async def guard_callback_owner(callback: CallbackQuery, data: Optional[dict]) -> bool:
    """Единая проверка: запрос существует и принадлежит нажавшему кнопку.
    Отвечает алертом и возвращает False, если данные устарели или это чужой
    запрос. Блокирует сценарий, когда посторонний человек в группе/инлайне
    тыкает в чужие кнопки генерации, скиллов, параметров и т.д."""
    if not data:
        await callback.answer(
            "Эта кнопка устарела (прошло много времени или бот перезапускался). "
            "Отправьте запрос заново.",
            show_alert=True,
        )
        return False
    owner_id = data.get("user_id")
    if owner_id is not None and callback.from_user.id != owner_id:
        await callback.answer("Это не ваш запрос", show_alert=True)
        return False
    return True

async def safe_edit(callback: CallbackQuery, text: str, reply_markup=None) -> None:
    if callback.message:
        await callback.message.edit_text(text, reply_markup=reply_markup)
    elif callback.inline_message_id:
        await bot.edit_message_text(
            inline_message_id=callback.inline_message_id,
            text=text,
            reply_markup=reply_markup,
        )

async def safe_send_extra(callback: CallbackQuery, text: str, reply_markup=None) -> None:
    if callback.message:
        await callback.message.answer(text, reply_markup=reply_markup)
    else:
        await bot.send_message(callback.from_user.id, text, reply_markup=reply_markup)

async def safe_send_file(chat_id: int, file_path: Path, caption: str = "", user_id: Optional[int] = None, reply_markup=None) -> Optional[Message]:
    if not file_path.exists():
        return None
    ext = file_path.suffix.lower()
    file_input = FSInputFile(str(file_path))
    try:
        if ext in [".png", ".jpg", ".jpeg", ".gif"]:
            return await bot.send_photo(chat_id, file_input, caption=caption, reply_markup=reply_markup)
        elif ext in [".zip", ".rar", ".7z", ".tar"]:
            return await bot.send_document(chat_id, file_input, caption=caption, reply_markup=reply_markup)
        else:
            # .svg и все остальные типы (код, текст, архивы) — как документ
            return await bot.send_document(chat_id, file_input, caption=caption, reply_markup=reply_markup)
    except Exception as e:
        logger.error(f"Failed to send file to chat {chat_id}: {e}")
        # Если не удалось отправить в чат (может быть inline), пробуем отправить лично
        if user_id:
            try:
                return await bot.send_document(user_id, file_input, caption=caption, reply_markup=reply_markup)
            except Exception as e2:
                logger.error(f"Failed to send file to user {user_id}: {e2}")
        return None

SYSTEM_PROMPT = f"""You are XGO v2.0, an advanced AI assistant powered by {MODEL_NAME}.
You think step by step before answering using structured reasoning.
Be helpful, accurate, and thorough.
Use markdown formatting in your answers.
If writing code, use proper code blocks with language specification.
When asked to create files, provide complete content and mention the filename.
When asked for tables, provide data in markdown table format."""
# ═══════════════════════════════════════════════════════════════════
# CORE GENERATION LOGIC (исправленная)
# ═══════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════
# SYSTEM PROMPTS — OpenAgent-style
# ═══════════════════════════════════════════════════════════════════

AGENT_SYSTEM_PROMPT ="""You are XGO v2.0 Agent, an advanced AI assistant with iterative reasoning.
You have access to tools that you can call to help the user.

AVAILABLE TOOLS:
- search: Web search for information. Args: {"query": "search terms"}
  · Formulate SHORT, SPECIFIC queries (2-6 words) — like a human typing into a search box, not a full sentence. "новый закон о такси 2026" beats "какой сейчас действует закон о такси в России в 2026 году".
  · If the user's question has several distinct parts or names several separate things (e.g. "compare X and Y", "what's new in A, B and C"), call search SEPARATELY for each part instead of one combined query — a combined query returns shallow results for everything and misses specifics on each.
  · Start broad, then narrow. If the first query's results are thin, vague, or don't answer the actual question, reformulate with different/more specific terms (add a year, a product version, a more exact name) and search again rather than settling for a weak result — up to ~4 searches for a single fact, more for genuinely broad/multi-part questions.
  · Prefer queries with concrete anchors — version numbers, dates, proper names — over generic phrasing. "aiogram 3.x FSM storage redis" beats "как использовать хранилище состояний в aiogram".
  · For "what's the latest/current version of X" style questions, include the current year in the query so stale pages don't dominate.
  · Do not call search for stable, well-known facts you already know confidently (historical events, established concepts, math, general programming knowledge). Call it when the answer could have changed since training, is about a specific current state (prices, versions, news, who holds a position now), or references something you're not confident about.
  · After getting results, actually use them — cite specific facts/numbers found, don't just gesture at "search results show...". If results are genuinely irrelevant or empty, say so honestly instead of inventing an answer.
- file_create: Create text files with code or documents. Args: {"filename": "name.txt", "content": "file content"}
- table: Create data tables as images. Args: {"headers": ["Col1", "Col2"], "rows": [["a", "b"]], "title": "Table", "subtitle": "optional subtitle", "col_types": ["text", "check", "status", "progress"]}
  · col_types is optional, one entry per column, same order as headers. Default is "text".
  · "check": renders a checkbox. Cell value should be "true"/"false"/"yes"/"no"/"да"/"нет".
  · "status": renders a colored badge (green/red/amber/purple depending on the word: ok/done/готово=green, error/ошибка/заблокирован=red, pending/ожидание=amber, anything else=purple).
  · "progress": renders a progress bar. Cell value should be a number 0-100 (with or without "%").
  · Use these when the data naturally fits (e.g. a "Done" column → check, a "Status" column → status, a "Completion" column → progress) — this makes tables much more useful than plain text.
- chart: Create a chart image. Args: {"type": "bar", "labels": ["A", "B", "C"], "values": [10, 25, 15], "title": "Chart title", "subtitle": "optional", "unit": "optional unit suffix like %, $, etc"}
  · "type" is one of: "bar" (default, compares categories), "line" (trend over time/sequence), "pie"/"donut" (share of a whole), "radar" (multi-dimensional comparison across axes), "scatter" (relationship between two numeric variables).
  · line/radar support multiple series: pass {"series": [{"name": "Series A", "values": [1,2,3]}, {"name": "Series B", "values": [4,5,6]}]} instead of a single "values" list — "labels" are then the shared x-axis (line) or axes (radar).
  · scatter uses {"points": [{"x": 1, "y": 2, "label": "optional point name"}, ...]} instead of labels/values.
  · pie/donut use "labels" + "values" like bar (values become percentages of the total automatically).
- graph: Create a node-link graph (network/relationship diagram, Obsidian-style Graph View) with automatic force-directed layout — you never need to compute node positions yourself. Two input modes:
  · Explicit: {"title": "...", "nodes": [{"id": "A", "label": "Node A", "group": "category1"}, ...], "edges": [{"source": "A", "target": "B"}, ...], "directed": false}. "group" colors nodes by cluster/category (optional). "directed": true draws arrowheads; leave false for a plain undirected web/spiderweb look.
  · From markdown: {"title": "...", "markdown": "# Note One\nLinks to [[Note Two]] #tagname\n\n# Note Two\nSome content"}. Parses "# Heading" blocks as notes, [[wiki-links]] inside them as edges, and #tags to color-code clusters — use this mode whenever the user gives you existing markdown/Obsidian-style notes to visualize, instead of manually extracting nodes/edges yourself.
  · Use this tool (not chart) whenever the user wants to see relationships/connections between things — notes, people, services, concepts — not just compare numeric values.
- archive: Create ZIP archives. Args: {"files": ["file1.txt", "file2.txt"], "archive_name": "archive.zip"}
- exec: Run code in an isolated sandbox and return stdout/stderr/exit code. Args: {"code": "print('hi')", "language": "python"}. Supported languages: python, js, bash. Has a strict timeout — do not use for long-running processes. Use this whenever the user asks you to run/test/execute a piece of code.
- presentation: Create a multi-slide PDF presentation. Args: {"title": "Deck title", "slides": [{"type": "title", "title": "Main Title", "body": "Subtitle"}, {"type": "content", "title": "Slide title", "bullets": ["point 1", "point 2"]}, {"type": "accent", "title": "Slide title", "body": "One big highlighted takeaway"}]}
  · slide "type" is one of: "title" (centered big title + subtitle, use as slide 1), "content" (title + bullet list), "accent" (title + one large highlighted statement, use sparingly for key takeaways).
  · Always build a real slide sequence (typically 4-10 slides: title slide, then content slides, optionally an accent slide for the key conclusion) — do not just dump everything into one slide.
- github_commit: Create or update a file in the user's connected GitHub repository. Args: {"path": "src/main.py", "content": "file contents", "message": "commit message"}. Only works if the user has connected a repo via /github — if the tool result says no repo is connected, tell the user to run /github first.
- github_read: Inspect the user's connected GitHub repository BEFORE writing anything that depends on the project's actual stack (e.g. a CI workflow). Args for listing all files: {"action": "list_files"}. Args for reading one file's contents: {"action": "read_file", "path": "package.json"}. Use list_files first to see what's in the repo, then read_file on the relevant manifest (package.json, Cargo.toml, pyproject.toml, pom.xml, go.mod, Dockerfile, etc.) to see the real dependencies/scripts before generating a workflow or making assumptions about the project.
- github_actions: Trigger or check a GitHub Actions workflow in the user's connected repo. Args for trigger: {"action": "trigger", "workflow_file": "build.yml", "inputs": {"optional": "key-value inputs the workflow accepts"}}. Args for status check: {"action": "status", "workflow_file": "build.yml"}. Workflows run asynchronously — after triggering, tell the user it started and that they can ask you to check status in a bit; do not pretend it finished immediately. The workflow file must already exist in .github/workflows/ in the repo (use github_commit to create it first if needed) and must have `on: workflow_dispatch:` as a trigger.
- ask_user: Pause and ask the USER (not yourself) one or more clarifying questions before continuing, when the task genuinely cannot be done well without a decision only they can make. Args: {"questions": [{"text": "question text", "options": ["short option A", "short option B", "short option C"]}, ...]}. 1 to 5 questions per call. Each question needs 2-4 short options (a few words each, shown as buttons) — the user can also always type a free-form answer instead of picking an option, so options are a convenience, not the only path. After calling this, execution PAUSES until the user answers — you will see their answer(s) as a new message before you continue. Only usable when explicitly told this task allows it (see ASK_USER RULES below).

ASK_USER RULES — this tool is the exception, not the default:
· Only call ask_user when a concrete choice would change WHAT you build or HOW you approach it, and you cannot reasonably infer the answer from the conversation (e.g. target audience, tone, a technology choice with no clear winner, scope/depth the user didn't specify, which of several valid interpretations they meant).
· Do NOT call ask_user for things you can just decide yourself (naming, minor formatting, obvious defaults) — make a reasonable choice and mention it in your final answer instead.
· Do NOT call ask_user on simple/light requests — only on medium or hard multi-step tasks where a wrong assumption would waste real work.
· Prefer ONE well-chosen question over several — only ask more (up to 5) when the task genuinely has that many independent open decisions.
· Never ask a question you could answer yourself by calling another tool (search, github_read, etc.) instead — use tools for facts, ask_user only for the user's own preferences/decisions.
· Call ask_user AT MOST ONCE per request — do not repeatedly pause for more questions after getting answers; use the answers and proceed to completion.

WRITING GITHUB ACTIONS .yml WORKFLOWS — NEVER USE A GENERIC TEMPLATE:
When asked to create a CI/build/test workflow for a connected repo, ALWAYS call github_read (action=list_files, then read_file on the relevant manifest) FIRST to see the actual project — do not guess the language/framework from the user's phrasing alone. Detect the real stack from what's actually there — e.g. a `package.json` with "next" means Next.js/npm, a `Cargo.toml` means Rust/cargo, a `pyproject.toml` with poetry means Python/Poetry, a `pom.xml` means Java/Maven, a `go.mod` means Go modules. Write the workflow specifically for THAT stack — correct setup-action, correct dependency cache key, correct build/test/lint commands for that project's actual tooling (read the manifest's scripts/dependencies, don't assume standard ones). Do not paste a one-size-fits-all "run npm install && npm test" skeleton when the project isn't even Node.js. Reference points for the setup action and typical steps per ecosystem (adapt exact commands to what the project actually uses):
  · Python (pip/poetry/uv): actions/setup-python@v5, cache dependencies by lockfile hash (requirements.txt/poetry.lock/uv.lock), run the project's actual test command (pytest, tox, etc).
  · Node.js/TypeScript (npm/yarn/pnpm): actions/setup-node@v4 with cache matching the lockfile present (package-lock.json→npm, yarn.lock→yarn, pnpm-lock.yaml→pnpm), install with the matching package manager, run the actual scripts defined in package.json (build/test/lint), not assumed ones.
  · Go: actions/setup-go@v5, `go build ./...`, `go test ./...`, respect go.mod's module/version.
  · Rust: actions-rs or dtolnay/rust-toolchain, cache ~/.cargo and target/ keyed on Cargo.lock, `cargo build --release`, `cargo test`.
  · Java/Kotlin (Maven/Gradle): actions/setup-java@v4, use the build tool actually present (pom.xml→mvn, build.gradle→gradle), cache accordingly.
  · Docker-based projects: build with `docker build`, consider buildx + layer caching if a Dockerfile is present instead of a language-specific setup action.
  Always include `on: workflow_dispatch:` (required for the github_actions trigger tool to work) alongside whatever other triggers make sense (push/pull_request). Pin action versions (e.g. @v4/@v5, not @master) for reproducibility. If genuinely uncertain about the project's exact build/test commands, say so and ask rather than inventing commands that don't exist in the project.

To call a tool, respond with EXACTLY one JSON block per tool call in this format:
```tool_call
{"tool": "tool_name", "args": {"arg1": "value1"}}
```

You can make multiple tool calls in one response by including multiple ```tool_call blocks.

After each tool call, you will see its result. Then decide whether to call more tools or give the final answer.

When you have enough information, respond with plain text (no tool calls) — that will be your final answer.

MANDATORY TOOL USE — these are not optional, do NOT answer from memory alone when the user's request matches:

· If the user asks to find/look up/search for something on the internet, check current/latest info, or references news, prices, versions, or anything time-sensitive — you MUST call search at least once before answering. Never claim you searched or found something online without actually calling the tool.
· If the user asks for a table, comparison table, or to "compare X and Y in a table" — you MUST call the table tool with real headers/rows/title to render an actual image. Do NOT just write a markdown table in your text answer — a markdown table is not an acceptable substitute for the table tool call.
· CRITICAL for tables: You MUST use the EXACT format tool_call\n{"tool": "table", "args": {"headers": [...], "rows": [[...]], "title": "..."}}\n. Do NOT output JSON without the tool_call wrapper. Do NOT output just JSON in the answer. The table tool MUST be called as a tool_call block, not as text in the final answer.
· If the user asks for a chart, graph of numeric values, or to "visualize" data (bar/line/pie/radar/scatter) — you MUST call the chart tool with real labels/values/title. Do NOT describe a chart in text instead.
· If the user asks to see connections/relationships between things (notes, people, services, concepts), a "graph of links", or gives you existing markdown/Obsidian notes to visualize — you MUST call the graph tool. Do NOT describe the graph in text or draw ASCII art instead.
· If the user asks to create/save/write a file, script, or code file — you MUST call file_create with the actual filename and content. Do NOT just paste code in the chat text instead.
· If the user asks you to run, execute, or test a piece of code and see its output — you MUST call exec. Do NOT just guess or describe what the output "would be". After calling exec, you MUST quote the actual stdout/stderr/exit code in your final text answer — the tool result is shown in a collapsed "Tools Used" section that the user may not open, so your final answer needs to restate the real output, not just say "it ran successfully".
· If the user asks for a presentation, slide deck, or slides — you MUST call presentation with a real multi-slide structure. Do NOT just write slide content as plain text.
· If the user asks to commit/push/save a file to their GitHub repo — you MUST call github_commit. Never claim you committed something without actually calling the tool.
· If the user asks to run/trigger a GitHub Actions build, workflow, or CI/CD pipeline — you MUST call github_actions. Never claim a build started or finished without actually calling the tool.
· If the user asks to CREATE/WRITE a new GitHub Actions workflow (.yml) for their project — you MUST call github_read (list_files, then read the relevant manifest) BEFORE writing the workflow content, so it matches the project's real stack instead of being a generic guess.
· If the user asks to archive/zip files — you MUST call archive.
· Combined requests need combined tool use: e.g. "search X and compare in a table" requires BOTH a search call AND a table call, in that order.
· Only skip tools if the user's request is a general knowledge/opinion question with no explicit signal above.

FORMAT IS STRICT — NEVER FAKE A TOOL CALL:
· The ONLY valid way to call a tool is the exact ```tool_call block with raw JSON shown above. Never invent alternative syntaxes like `table(headers=..., rows=...)`, never prefix it with icons like ⚙ or ✓, never write it as a "log line".
· NEVER output a fake result line such as "Table rendered: xyz.png" or "File created: xyz.txt" yourself — that text is only ever generated by the actual tool after you correctly call it. If you write that sentence without a preceding real tool_call block, you are lying to the user about a file that does not exist.
· If you are not calling a tool, do not mention filenames, "rendered", or "saved" at all — just answer in plain text.

Be concise in tool calls but thorough in final answers.

CRITICAL — FINAL ANSWER STYLE:
Your final answer (the plain-text response with no tool_call blocks) is shown to the user AS-IS, with no wrapper, no header, no labels. It must read like a normal, direct answer to their question — never like a report about your own process. This means:
· NEVER mention "thinking process", "thinking note", "plan", "step 1/2/3", "tool call", "final answer", or any other reference to your own reasoning mechanics.
· NEVER start with meta phrases like "Let me analyze...", "Let me think about this...", "I will now...", "Based on my analysis...", "To answer this, I first...".
· NEVER narrate what you did ("I searched for X and found...", "I used the search tool to...") — just state the information itself. If attribution to a source is useful, name the source naturally ("According to Reuters...", "Google's documentation says...") without describing your own tool usage.
· Do not reference `[system: your plan was]` markers or any other internal scaffolding that may appear earlier in the conversation — those are not part of what the user said or asked about.
· Answer as if you already knew this and are simply telling the user — not as if you are reporting back from an investigation."""

THINKING_NOTE_PROMPT = """Before answering, think through HOW you will approach this task -- not WHAT was asked.

Do NOT restate, paraphrase, or summarize the user's request -- the user already knows what they asked. Instead, reason like a real plan: what's the actual approach, what needs to be checked or done first, what could go wrong, which tool (if any) is the right one and why. This must read as genuine reasoning about the solution, never as "user wants X" or "the request is about Y".

Respond with EXACTLY one tool call to thinking.note containing that reasoning (max 180 chars).

```tool_call
{"tool": "thinking.note", "args": {"note": "Your actual reasoning/plan for solving this (max 180 chars)"}}
```

Do not include any other text."""

FINALIZE_PROMPT = "Stop using tools. Give the final user-facing answer now. Do not mention the reasoning process unless asked."

# Возвращается _tool_loop вместо текста ответа, когда агент приостановился
# на ask_user -- process_generation() распознаёт это и вместо обычного
# результата отправляет юзеру вопросы с кнопками (см. _resume_agent_after_answer).
AWAITING_USER_ANSWER_SENTINEL = "\x00__AWAITING_USER_ANSWER__\x00"

THINKING_QUESTIONS_PROMPT = """This looks like a medium-to-hard task. Before solving it, break it down into 2-4 short, concrete self-questions -- the kind of questions an expert would silently ask themselves before starting, not questions to send back to the user. Examples of the RIGHT kind: "What exactly counts as done here?", "What could break this approach?", "What's the actual bottleneck?", "Which of these options fits the constraints?". Do NOT ask questions the user should answer -- these are your own checklist for tackling the task, not clarifying questions for the user.

Respond with EXACTLY one tool call to thinking.questions.

```tool_call
{"tool": "thinking.questions", "args": {"questions": ["question 1", "question 2", "question 3"]}}
```

Do not include any other text."""

# ═══════════════════════════════════════════════════════════════════
# OPENAGENT CORE — XGOAgent
# ═══════════════════════════════════════════════════════════════════

class XGOAgent:
    MAX_STEPS = AGENT_MAX_STEPS
    MAX_ERROR_RETRIES = 3
    STATUS_MIN_INTERVAL = 0.6  # секунд между edit_message_text, чтобы не упереться в rate limit

    def __init__(
        self,
        user_id: int,
        session: UserSession,
        params: GenerationParams,
        chat_id: Optional[int] = None,
        inline_message_id: Optional[str] = None,
        thinking_msg: Optional[Message] = None,
    ):
        self.user_id = user_id
        self.session = session
        self.params = params
        self.chat_id = chat_id
        self.inline_message_id = inline_message_id
        self.thinking_msg = thinking_msg
        self.messages: List[dict] = []
        self.tool_results: List[ToolResult] = []
        self.thinking_notes: List[str] = []
        self.last_reasoning: str = ""  # заполняется _call_model, если модель вернула честный reasoning_content
        self.effective_model: Optional[str] = None  # выставляется в run() -> _route_model()
        self.complexity: str = "light"  # выставляется в run() -> _classify_complexity()
        self.tool_call_log: List[Dict] = []
        self.agent_log: List[str] = []
        self.final_answer: str = ""
        self.usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        self.tree_nodes: List[Dict[str, str]] = []  # {"label": ..., "state": "active"|"done"|"error"}
        self._last_status_text: Optional[str] = None
        self._last_status_ts: float = 0.0
        self.asked_user: bool = False  # ask_user разрешён максимум раз за прогон
        self.pending_questions: Optional[List[Dict]] = None  # выставляется при паузе на ask_user
        self._pending_mandatory_tools: List[str] = []  # для resume _tool_loop после паузы

    def _render_tree(self) -> str:
        header = f"{SYM['root']} <b>XGO Agent</b> {SYM['dot']} рассуждаю..."
        if not self.tree_nodes:
            return header
        lines = [header]
        last_idx = len(self.tree_nodes) - 1
        for i, node in enumerate(self.tree_nodes):
            connector = SYM["tree_l"] if i == last_idx else SYM["tree_t"]
            state = node.get("state", "done")
            icon = {"active": SYM["step"], "done": SYM["check"], "error": SYM["cross"]}.get(state, SYM["node"])
            lines.append(f"  {connector} {icon} {node['label']}")
        return "\n".join(lines)

    def _push_node(self, label: str, state: str = "done") -> None:
        self.tree_nodes.append({"label": label, "state": state})

    def _update_last_node_state(self, state: str) -> None:
        if self.tree_nodes:
            self.tree_nodes[-1]["state"] = state

    async def _status(self, text: Optional[str] = None, force: bool = False):
        """Перерисовывает дерево прогресса целиком. `text`, если передан, добавляется
        как активный узел перед рендером (для разовых статусов вроде 'Analyzing...')."""
        if text is not None:
            self._push_node(text, state="active")

        rendered = self._render_tree()
        if rendered == self._last_status_text and not force:
            return
        now = time.monotonic()
        if not force and (now - self._last_status_ts) < self.STATUS_MIN_INTERVAL:
            return
        self._last_status_text = rendered
        self._last_status_ts = now

        try:
            if self.thinking_msg:
                await self.thinking_msg.edit_text(rendered)
            elif self.inline_message_id:
                await bot.edit_message_text(inline_message_id=self.inline_message_id, text=rendered)
        except Exception:
            pass

    def _build_system_prompt(self) -> str:
        base = AGENT_SYSTEM_PROMPT
        if self.session.active_skills:
            base = state.skill_manager.get_active_prompt(self.session.active_skills, base)
        return base

    def _detect_mandatory_tools(self, query: str) -> List[str]:
        """Консервативные, недвусмысленные триггеры для программного форсирования тулов.
        В отличие от ToolManager.detect_needed_tools (используется UI-кнопками и может быть
        wider/шумнее), здесь только явные однозначные сигналы, чтобы не форсировать поиск
        на обычных вопросах."""
        q = query.lower()
        mandatory: List[str] = []

        search_triggers = [
            "найди в интернете", "найди в сети", "погугли", "поищи в интернете",
            "поищи в сети", "загугли", "найди информацию в интернете",
            "search the web", "search online", "look up online", "найди онлайн",
            "актуальную информацию", "последние новости", "свежие новости",
        ]
        if any(t in q for t in search_triggers):
            mandatory.append("search")

        table_triggers = [
            "сделай таблицу", "создай таблицу", "построй таблицу", "покажи таблицу",
            "выведи таблицу", "в таблице", "таблицей", "сравни их в таблице",
            "сравни в таблице", "make a table", "create a table", "compare in a table",
            "comparison table",
        ]
        if any(t in q for t in table_triggers):
            mandatory.append("table")

        file_triggers = [
            "создай файл", "сохрани в файл", "сделай файл", "создать файл",
            "create a file", "save to a file", "write a file", "сохрани как файл",
        ]
        if any(t in q for t in file_triggers):
            mandatory.append("file_create")

        archive_triggers = [
            "заархивируй", "упакуй в zip", "сделай архив", "создай архив",
            "create a zip", "make an archive",
        ]
        if any(t in q for t in archive_triggers):
            mandatory.append("archive")

        return mandatory

    def _prepare_context(self, query: str):
        system = self._build_system_prompt()
        self.messages = [{"role": "system", "content": system}]
        # "Caveman"-компрессия: только последние сообщения идут дословно,
        # всё, что старше — сжато в компактный дайджест (см.
        # UserSession.get_context_messages). Экономит токены на каждый
        # запрос, особенно в длинных диалогах, где раньше уходили последние
        # 10 сообщений ПОЛНОСТЬЮ на каждый шаг агента.
        for msg in self.session.get_context_messages():
            self.messages.append(msg)
        self.messages.append({"role": "user", "content": query})

    async def _call_model(self, messages_override: List[dict] = None) -> str:
        msgs = messages_override or self.messages
        result = await fm_client.chat_completion(
            messages=msgs,
            model=self.effective_model,
            max_tokens=self.params.max_tokens,
            temperature=self.params.temperature,
            top_p=self.params.top_p,
        )
        choice = result.get("choices", [{}])[0]
        message = choice.get("message", {})
        content = message.get("content", "")
        # Reasoning-модели (например nemotron-*-reasoning) присылают своё
        # РЕАЛЬНОЕ рассуждение отдельным полем -- разные провайдеры зовут
        # его по-разному, поэтому проверяем известные варианты. Если поле
        # есть -- это настоящие раздумья модели, а не наша искусственная
        # обёртка через tool_call thinking.note (см. _thinking_note ниже).
        reasoning_raw = (
            message.get("reasoning_content")
            or message.get("reasoning")
            or choice.get("reasoning_content")
        )
        self.last_reasoning = reasoning_raw.strip() if isinstance(reasoning_raw, str) else ""
        usage = result.get("usage", {})
        self.usage["prompt_tokens"] += usage.get("prompt_tokens", 0)
        self.usage["completion_tokens"] += usage.get("completion_tokens", 0)
        self.usage["total_tokens"] += usage.get("total_tokens", 0)
        return content or ""

    def _extract_tool_calls(self, text: str) -> List[Dict]:
        calls = []
        pattern = r"```tool_call\s*\n(.*?)\n```"
        matches = re.findall(pattern, text, re.DOTALL)
        for match in matches:
            try:
                data = json.loads(match.strip())
                if "tool" in data and "args" in data:
                    calls.append(data)
            except json.JSONDecodeError:
                try:
                    data = json.loads(match.strip())
                    if "tool" in data:
                        calls.append(data)
                except:
                    pass
        if not calls:
            xml_pattern = r"<tool\s+name=\"([^\"]+)\"[^>]*>(.*?)</tool>"
            for name, args_text in re.findall(xml_pattern, text, re.DOTALL):
                try:
                    args = json.loads(args_text.strip()) if args_text.strip() else {}
                except:
                    args = {"query": args_text.strip()}
                calls.append({"tool": name, "args": args})
        if not calls:
            calls.extend(self._extract_function_style_calls(text))
        return calls

    # Фолбэк: модель иногда "рисует" вызов тула в виде псевдо-лога
    # (например "⚙ table(headers=[...], rows=[...])") вместо честного
    # ```tool_call``` JSON-блока. Ловим известные имена тулов и пытаемся
    # разобрать их kwargs как питоно-подобный литерал, чтобы реально
    # выполнить тул, а не просто поверить тексту модели на слово.
    _KNOWN_TOOL_NAMES = ("search", "file_create", "table", "chart", "archive", "exec", "presentation", "github_commit", "github_read", "github_actions", "thinking.note")

    def _extract_function_style_calls(self, text: str) -> List[Dict]:
        calls = []
        pattern = r"(?:^|\n)\s*[⚙✓]?\s*(" + "|".join(re.escape(n) for n in self._KNOWN_TOOL_NAMES) + r")\((.*?)\)\s*(?:\n|$)"
        for name, kwargs_text in re.findall(pattern, text, re.DOTALL):
            kwargs_text = kwargs_text.strip()
            if not kwargs_text:
                calls.append({"tool": name, "args": {}})
                continue
            try:
                import ast
                # Оборачиваем как вызов функции и парсим через ast, чтобы
                # безопасно принять python-литералы (списки, словари, строки)
                # без eval() пользовательского текста.
                parsed = ast.parse(f"f({kwargs_text})", mode="eval")
                call_node = parsed.body
                args = {}
                for kw in call_node.keywords:
                    if kw.arg is not None:
                        args[kw.arg] = ast.literal_eval(kw.value)
                if args:
                    calls.append({"tool": name, "args": args})
            except Exception:
                continue
        return calls

    @staticmethod
    def _preview_arg_value(v, max_len: int = 50) -> str:
        """Маленькие значения аргумента показываем как есть -- полезно
        видеть, что реально передаётся. Большие (длинные строки, списки,
        словари -- например nodes/labels/markdown у chart и graph) сворачиваем
        в короткую метку, чтобы «раздумья» в дереве не превращались в дамп
        сырых данных тула."""
        if isinstance(v, list):
            return f"[{len(v)} эл.]"
        if isinstance(v, dict):
            return f"{{{len(v)} ключ.}}"
        s = str(v)
        return s if len(s) <= max_len else s[:max_len].rstrip() + "…"

    @staticmethod
    def _sanitize_ask_user_questions(raw) -> List[Dict]:
        """Валидирует args.questions от ask_user: 1-5 вопросов, каждый с
        текстом и 2-4 короткими вариантами-кнопками. Мусор (не список,
        вопрос без текста, слишком много вариантов) отбрасывается вместо
        падения -- лучше меньше валидных вопросов, чем сломанный tool_call."""
        if not isinstance(raw, list):
            return []
        out = []
        for item in raw[:5]:
            if isinstance(item, str):
                text, options = item.strip(), []
            elif isinstance(item, dict):
                text = str(item.get("text", "")).strip()
                options = item.get("options") or []
            else:
                continue
            if not text:
                continue
            clean_options = [re.sub(r"\s+", " ", str(o)).strip()[:40] for o in options if str(o).strip()][:4]
            out.append({"text": text[:300], "options": clean_options})
        return out

    async def _execute_tool_call(self, tool_call: Dict) -> ToolResult:
        tool_name = tool_call.get("tool", "")
        args = tool_call.get("args", {})
        query = args.get("query", "")
        self.tool_call_log.append({"tool": tool_name, "args": args})
        args_preview = ", ".join(f"{k}={self._preview_arg_value(v)}" for k, v in list(args.items())[:2])
        self.agent_log.append(f"{tool_name}({args_preview})")
        await self._status(f"{SYM['tool']} <code>{TextFormatter.esc(tool_name)}</code>({TextFormatter.esc(args_preview)})")
        try:
            extra_args = {k: v for k, v in args.items() if k != "query"}
            # Прокидываем user_id тулам, которым нужен персональный контекст
            # (например GitHub-подключение) — модель этот параметр никогда
            # не передаёт сама, это внутренняя инъекция агентского цикла.
            extra_args["_user_id"] = self.user_id
            result = await state.tool_manager.execute_tool(tool_name, query, **extra_args)
            self.tool_results.append(result)
            state.global_stats["total_tools_used"] += 1
            self._update_last_node_state("done" if result.success else "error")
            await self._status(force=True)
            return result
        except Exception as e:
            err_result = ToolResult(tool_name, False, f"Error: {str(e)}")
            self.tool_results.append(err_result)
            self._update_last_node_state("error")
            await self._status(force=True)
            return err_result

    async def _thinking_note(self, query: str) -> str:
        await self._status(f"{SYM['think']} Анализирую запрос...")
        thinking_msgs = [
            {"role": "system", "content": self._build_system_prompt() + "\n\n" + THINKING_NOTE_PROMPT},
            {"role": "user", "content": query},
        ]
        note = "Analyzing request..."
        for attempt in range(2):
            response = await self._call_model(thinking_msgs)
            if self.last_reasoning:
                # Модель — reasoning (например nemotron-*-reasoning) и уже
                # прислала настоящую цепочку рассуждений отдельным полем.
                # Используем её как есть вместо искусственного thinking.note
                # tool_call -- но в ТОМ ЖЕ формате отображения (одна строка,
                # тот же лимит в 180 символов), что и у обычных моделей.
                note = re.sub(r"\s+", " ", self.last_reasoning).strip()[:180]
                break
            calls = self._extract_tool_calls(response)
            found_note = None
            for call in calls:
                if call.get("tool") == "thinking.note":
                    found_note = call.get("args", {}).get("note", "").strip()
                    break
            if found_note:
                # Санитизация: даже если модель вернула валидный tool_call, но
                # засунула в note многострочное рассуждение вместо короткого
                # плана — схлопываем в одну строку и жёстко обрезаем, чтобы
                # полноценная "речь" модели не протекала в блок размышлений.
                found_note = re.sub(r"\s+", " ", found_note).strip()
                note = found_note[:180]
                # ВАЖНО: raw response (с сырым tool_call блоком thinking.note)
                # в self.messages больше НЕ добавляется. Раньше эта строка
                # клала в историю неподтверждённый tool_call, который модель
                # на следующем шаге видела как "я ещё не получила результат
                # этого вызова" — это путало её и приводило к преждевременным
                # ответам. История получает только санитизированную заметку
                # ниже (через "[system: your plan was]"), без сырого JSON.
                break
            # Модель не вернула валидный thinking.note — просим ещё раз строго по формату
            thinking_msgs.append({"role": "assistant", "content": response})
            thinking_msgs.append({
                "role": "user",
                "content": "Invalid format. Respond with EXACTLY one tool_call block for thinking.note, nothing else.",
            })
        else:
            # Не смогли получить валидный формат за 2 попытки — используем короткую заглушку,
            # НЕ произвольный текст модели (чтобы не протащить в thinking полноценный ответ)
            note = "Analyzing request and planning approach..."

        self.thinking_notes.append(note)
        self.messages.append({"role": "user", "content": f"[system: your plan was] {note}"})
        # Заменяем плейсхолдер "Анализирую запрос..." на реальный вывод модели
        if self.tree_nodes:
            self.tree_nodes[-1]["label"] = f"{SYM['think']} {TextFormatter.esc(note[:120])}"
            self.tree_nodes[-1]["state"] = "done"
        await self._status(force=True)
        return note

    async def _thinking_questions(self, query: str) -> List[str]:
        """Для задач, классифицированных как «тяжёлые» (см.
        _classify_complexity): модель сама формулирует несколько
        конкретных под-вопросов по задаче (не для юзера — для себя, как
        чек-лист перед решением) и они попадают и в контекст модели, и в
        дерево размышлений юзеру как отдельные узлы -- видимая декомпозиция
        задачи, а не просто "думаю..."."""
        await self._status(f"{SYM['decide']} Формулирую под-вопросы по задаче...")
        q_msgs = [
            {"role": "system", "content": self._build_system_prompt() + "\n\n" + THINKING_QUESTIONS_PROMPT},
            {"role": "user", "content": query},
        ]
        questions: List[str] = []
        for attempt in range(2):
            response = await self._call_model(q_msgs)
            calls = self._extract_tool_calls(response)
            found = None
            for call in calls:
                if call.get("tool") == "thinking.questions":
                    found = call.get("args", {}).get("questions", [])
                    break
            if found:
                questions = [re.sub(r"\s+", " ", str(qq)).strip()[:140] for qq in found if str(qq).strip()][:4]
                break
            q_msgs.append({"role": "assistant", "content": response})
            q_msgs.append({
                "role": "user",
                "content": "Invalid format. Respond with EXACTLY one tool_call block for thinking.questions, nothing else.",
            })

        if not self.tree_nodes:
            self._push_node(f"{SYM['decide']} Под-вопросы по задаче", state="done")
        else:
            self.tree_nodes[-1]["label"] = f"{SYM['decide']} Под-вопросы по задаче"
            self.tree_nodes[-1]["state"] = "done"

        for qq in questions:
            self._push_node(f"{SYM['leaf']} {TextFormatter.esc(qq)}", state="done")
        await self._status(force=True)

        if questions:
            bullet_list = "\n".join(f"- {qq}" for qq in questions)
            self.messages.append({
                "role": "user",
                "content": f"[system: work through these before answering]\n{bullet_list}",
            })
        return questions

    async def _tool_loop(self, mandatory_tools: Optional[List[str]] = None) -> str:
        mandatory_tools = mandatory_tools or []
        forced_attempts = 0
        max_forced_attempts = 2  # не долбим модель бесконечно, если она упорно отказывается
        step = 0
        while step < self.MAX_STEPS:
            step += 1
            await self._status(f"{SYM['brain']} Шаг {step}/{self.MAX_STEPS}: рассуждаю...")
            response = await self._call_model()
            tool_calls = self._extract_tool_calls(response)

            if not tool_calls:
                used_tools = {tc.get("tool") for tc in self.tool_call_log}
                missing = [t for t in mandatory_tools if t not in used_tools]
                # Отдельная защита от преждевременной финализации: если модель
                # не вызвала ни одного инструмента ЗА ВЕСЬ прогон (не только
                # мандаторных) и выдала подозрительно короткий ответ (<60
                # символов) — это обычно обрыв рассуждения на середине, а не
                # осознанный краткий ответ. Форсируем ещё один шаг вместо
                # того, чтобы отдавать пользователю такой ответ как финальный.
                premature = (
                    not self.tool_call_log
                    and len(response.strip()) < 60
                    and forced_attempts < max_forced_attempts
                )
                if missing and forced_attempts < max_forced_attempts:
                    # Модель попыталась завершить ответ, не вызвав обязательный тул — не принимаем
                    forced_attempts += 1
                    self._update_last_node_state("error")
                    self._push_node(
                        f"{SYM['warning']} Пропущен обязательный тул: {', '.join(missing)}, форсирую...",
                        state="active",
                    )
                    await self._status(force=True)
                    self.messages.append({"role": "assistant", "content": response})
                    self.messages.append({
                        "role": "user",
                        "content": (
                            f"You did not call the required tool(s): {', '.join(missing)}. "
                            f"This is mandatory for this request. Call the tool now with a tool_call block "
                            f"before giving your final answer."
                        ),
                    })
                    self._update_last_node_state("done")
                    continue
                if premature:
                    forced_attempts += 1
                    self._update_last_node_state("error")
                    self._push_node(
                        f"{SYM['warning']} Ответ выглядит незавершённым, продолжаю рассуждение...",
                        state="active",
                    )
                    await self._status(force=True)
                    self.messages.append({"role": "assistant", "content": response})
                    self.messages.append({
                        "role": "user",
                        "content": (
                            "Your response looks incomplete or cut off. Continue reasoning "
                            "and either call a tool or give a proper, complete final answer."
                        ),
                    })
                    self._update_last_node_state("done")
                    continue
                self._update_last_node_state("done")
                self._push_node(f"{SYM['answer']} Готово", state="done")
                await self._status(force=True)
                self.final_answer = response
                return response
            # Шаг привёл к вызову инструментов — помечаем узел шага как done,
            # сами инструменты добавят собственные узлы внутри _execute_tool_call
            self._update_last_node_state("done")

            # ask_user — особый случай: не обычный тул через ToolManager, а
            # пауза всего цикла до ответа юзера. Разрешён только для
            # medium/heavy (см. _classify_complexity) и максимум раз за
            # прогон (self.asked_user), чтобы модель не превращала диалог в
            # бесконечный допрос.
            ask_call = next((tc for tc in tool_calls if tc.get("tool") == "ask_user"), None)
            if ask_call and self.complexity in ("medium", "heavy") and not self.asked_user:
                questions = self._sanitize_ask_user_questions(ask_call.get("args", {}).get("questions"))
                if questions:
                    self.asked_user = True
                    self.pending_questions = questions
                    # Записываем сырой tool_call в историю как обычно, ответ
                    # придёт позже отдельным сообщением от юзера (см.
                    # _resume_after_answers) -- это НЕ финальный ответ,
                    # self.final_answer намеренно не выставляется.
                    self.messages.append({"role": "assistant", "content": response})
                    for label in (f"{SYM['leaf']} {TextFormatter.esc(q['text'][:100])}" for q in questions):
                        self._push_node(label, state="active")
                    await self._status(force=True)
                    return AWAITING_USER_ANSWER_SENTINEL

            for tc in tool_calls:
                if tc.get("tool") == "ask_user":
                    # Не разрешено в этом контексте (light-задача, или уже
                    # спрашивали раз) -- сообщаем модели и не выполняем как тул.
                    self.messages.append({
                        "role": "user",
                        "content": "[system] ask_user is not available right now. Make a reasonable assumption and continue, or give your final answer.",
                    })
                    continue
                result = await self._execute_tool_call(tc)
                result_text = f"[Tool: {tc.get('tool', 'unknown')}]\n{result.result}"
                self.messages.append({"role": "user", "content": result_text})
        self._push_node(f"{SYM['warning']} Лимит шагов достигнут, финализирую...", state="active")
        await self._status(force=True)
        await self._force_finalize()
        self._update_last_node_state("done")
        self._push_node(f"{SYM['answer']} Готово", state="done")
        await self._status(force=True)
        return self.final_answer

    async def _force_finalize(self):
        self.messages.append({"role": "user", "content": FINALIZE_PROMPT})
        response = await self._call_model()
        self.final_answer = response

    async def run(self, query: str) -> Tuple[str, str, dict, List[Dict]]:
        self.effective_model = self.session.model
        self.complexity = self._classify_complexity(query)
        self._prepare_context(query)
        mandatory_tools = self._detect_mandatory_tools(query)
        self._pending_mandatory_tools = mandatory_tools  # для resume после паузы на ask_user
        await self._thinking_note(query)
        if self.complexity in ("medium", "heavy"):
            await self._thinking_questions(query)
        result = await self._tool_loop(mandatory_tools)
        if result == AWAITING_USER_ANSWER_SENTINEL:
            # Пауза на ask_user: final_answer намеренно пуст, pending_questions
            # уже выставлен в _tool_loop -- process_generation читает его и
            # отправляет вопросы вместо обычного результата.
            self.final_answer = AWAITING_USER_ANSWER_SENTINEL
        thinking = "\n".join(self.thinking_notes)
        return thinking, self.final_answer, self.usage, self.tool_call_log

    @staticmethod
    def _classify_complexity(query: str) -> str:
        """Грубая эвристика с тремя уровнями:
        - light: короткий/простой вопрос, без само-вопросов и без права на ask_user
        - medium: похоже на многошаговую, но не самую тяжёлую задачу
        - heavy: явно сложная многошаговая задача (архитектура, отладка,
          рефакторинг, подробный анализ, длинный текст)
        medium и heavy получают шаг _thinking_questions и право вызывать
        ask_user (см. _tool_loop) -- у light его нет, чтобы не задавать
        уточнений на простых вопросах."""
        q = query.lower()
        heavy_markers = (
            "проанализируй", "анализ", "объясни подробно", "сравни", "разберись",
            "докажи", "оптимизируй", "рефактор", "архитектур", "спроектируй",
            "напиши код", "реализуй", "отладь", "почему", "debug", "analyze",
            "compare", "design", "architecture", "prove", "optimize",
            "explain in detail", "step by step", "пошагово",
        )
        medium_markers = (
            "напиши", "составь", "придумай", "создай", "сделай", "помоги с",
            "план", "стратегия", "write", "create", "generate", "plan", "strategy",
        )
        if len(query) > 400 or any(m in q for m in heavy_markers):
            return "heavy"
        if len(query) > 120 or any(m in q for m in medium_markers):
            return "medium"
        return "light"
# ═══════════════════════════════════════════════════════════════════
# CORE GENERATION LOGIC (OpenAgent-style)
# ═══════════════════════════════════════════════════════════════════

_response_cache: dict[str, dict] = {}

# Приостановленные на ask_user агенты: id -> {"agent": XGOAgent, "chat_id":...,
# "user_id":..., "created_at":...}. Живёт в памяти процесса (как и
# _response_cache) -- юзер отвечает кнопкой/текстом, ответ дописывается в
# agent.messages и _tool_loop продолжается с того же места.
_paused_agents: dict[str, dict] = {}
PAUSED_AGENT_TTL_SECONDS = 24 * 3600  # столько же, сколько RESPONSE_CACHE_TTL_SECONDS -- без таймаута ожидания ответа, но не вечно в памяти

async def _cleanup_expired_caches():
    """Фоновая задача: раз в CACHE_CLEANUP_INTERVAL_SECONDS выкидывает
    устаревшие записи из pending_prompts и _response_cache по TTL.
    Держит память бота ограниченной при долгой работе без рестарта и делает
    "данные устарели" предсказуемым (по времени), а не случайным следствием
    накопления мусора или падения процесса."""
    while True:
        await asyncio.sleep(CACHE_CLEANUP_INTERVAL_SECONDS)
        try:
            now = time.time()
            expired_prompts = [
                pid for pid, data in state.pending_prompts.items()
                if now - data.get("created_at", now) > PENDING_PROMPT_TTL_SECONDS
            ]
            for pid in expired_prompts:
                state.pending_prompts.pop(pid, None)
            if expired_prompts:
                state.save_pending_prompts()

            expired_responses = [
                rid for rid, data in _response_cache.items()
                if now - data.get("created_at", now) > RESPONSE_CACHE_TTL_SECONDS
            ]
            for rid in expired_responses:
                _response_cache.pop(rid, None)

            expired_paused = [
                pid for pid, data in _paused_agents.items()
                if now - data.get("created_at", now) > PAUSED_AGENT_TTL_SECONDS
            ]
            for pid in expired_paused:
                _paused_agents.pop(pid, None)

            if expired_prompts or expired_responses or expired_paused:
                logger.info(
                    f"Cache cleanup: removed {len(expired_prompts)} pending_prompts, "
                    f"{len(expired_responses)} response_cache entries, "
                    f"{len(expired_paused)} paused_agents entries"
                )
        except Exception as e:
            logger.error(f"Cache cleanup failed: {e}")

async def process_generation(
    user_id: int,
    query: str,
    params: GenerationParams,
    session: UserSession,
    chat_id: Optional[int] = None,
    inline_message_id: Optional[str] = None,
    thinking_msg: Optional[Message] = None,
    display_prompt: Optional[str] = None,
    resume_agent: Optional["XGOAgent"] = None,
) -> None:
    """resume_agent: если задан -- это продолжение агента, ранее
    приостановленного на ask_user (см. _paused_agents). В этом случае query
    уже дописан в resume_agent.messages как ответ юзера вызывающей стороной
    (см. _resume_paused_agent), а сам объект agent просто продолжает
    _tool_loop с того же места вместо создания нового XGOAgent с нуля."""
    started = time.monotonic()
    shown_prompt = display_prompt if display_prompt is not None else query

    if user_id != OWNER_ID and resume_agent is None:
        limit = int(bot_settings.get("rate_limit", 30) or 30)
        if not rate_limiter.check(user_id, limit):
            await _notify_generation_error(
                inline_message_id, thinking_msg, chat_id,
                f"{SYM['cross']} <b>Слишком много запросов</b>\n\n"
                f"Лимит: {limit}/мин. Подождите немного и попробуйте снова.",
            )
            return

    if resume_agent is not None:
        agent = resume_agent
        agent.thinking_msg = thinking_msg
        agent.chat_id = chat_id or agent.chat_id
        agent.inline_message_id = inline_message_id
    else:
        agent = XGOAgent(
            user_id=user_id,
            session=session,
            params=params,
            chat_id=chat_id,
            inline_message_id=inline_message_id,
            thinking_msg=thinking_msg,
        )

    try:
        if resume_agent is not None:
            # Продолжение после ask_user: пропускаем thinking_note/thinking_questions
            # (уже были сделаны до паузы), просто едем дальше по tool_loop.
            result = await asyncio.wait_for(
                agent._tool_loop(agent._pending_mandatory_tools or []),
                timeout=AGENT_TOTAL_TIMEOUT_SECONDS,
            )
            if result == AWAITING_USER_ANSWER_SENTINEL:
                agent.final_answer = AWAITING_USER_ANSWER_SENTINEL
            thinking = "\n".join(agent.thinking_notes)
            answer, usage, tool_calls = agent.final_answer, agent.usage, agent.tool_call_log
        else:
            thinking, answer, usage, tool_calls = await asyncio.wait_for(
                agent.run(query), timeout=AGENT_TOTAL_TIMEOUT_SECONDS
            )
    except asyncio.TimeoutError:
        logger.error(f"Generation timeout for user {user_id} after {AGENT_TOTAL_TIMEOUT_SECONDS}s")
        error_text = (
            f"{SYM['cross']} <b>Превышено время ожидания</b>\n\n"
            f"Модель не ответила за {AGENT_TOTAL_TIMEOUT_SECONDS}с. "
            f"Попробуйте ещё раз или упростите запрос."
        )
        await _notify_generation_error(inline_message_id, thinking_msg, chat_id, error_text)
        return
    except Exception as e:
        logger.error(f"Error during agent.run for user {user_id}: {e}", exc_info=True)
        error_text = (
            f"{SYM['cross']} <b>Ошибка генерации</b>\n\n"
            f"<code>{TextFormatter.esc(str(e) or type(e).__name__)}</code>\n\n"
            f"Попробуйте повторить запрос. Если ошибка повторяется — "
            f"пришлите разработчику это сообщение целиком."
        )
        await _notify_generation_error(inline_message_id, thinking_msg, chat_id, error_text)
        return

    if answer == AWAITING_USER_ANSWER_SENTINEL:
        # Агент приостановился на ask_user -- вместо обычного результата
        # отправляем вопросы с кнопками и сохраняем agent для продолжения.
        await _send_ask_user_questions(agent, query, params, session, chat_id, inline_message_id, thinking_msg, shown_prompt)
        return

    # С этого момента ответ модели УЖЕ получен и не должен потеряться — любая
    # ошибка ниже (отправка в Telegram, заливка файлов) не должна выглядеть
    # как "ошибка генерации", а сам ответ по возможности всё равно должен
    # дойти до пользователя хотя бы в урезанном виде.
    try:
        elapsed = time.monotonic() - started

        state.global_stats["total_requests"] += 1
        state.global_stats["total_tokens"] += usage.get("total_tokens", 0)
        session.add_message("user", query)
        session.add_message("assistant", answer)

        pages = TextFormatter.split_into_pages(answer)
        total_pages = len(pages)
        request_id = str(uuid.uuid4())[:12]

        page_text = TextFormatter.format_full_response(
            prompt=shown_prompt,
            thinking=thinking,
            answer=pages[0],
            elapsed=elapsed,
            tokens=usage,
            page_num=1,
            total_pages=total_pages,
            model=(agent.effective_model or session.model or provider_registry.get_active()['model']),
            tools_results=agent.tool_results,
            tool_calls=tool_calls,
        )

        # Собираем список реально созданных файлов (таблицы, код, архивы) из результатов тулов
        created_files: List[Dict[str, str]] = []
        for tr in agent.tool_results:
            if tr.success and tr.metadata and tr.metadata.get("filepath"):
                created_files.append({
                    "tool": tr.tool_name,
                    "filepath": tr.metadata["filepath"],
                    "name": Path(tr.metadata["filepath"]).name,
                })

        result_markup = (
            KeyboardBuilder.pagination_buttons(1, total_pages, request_id)
            if total_pages > 1
            else KeyboardBuilder.single_page_buttons(request_id)
        )

        _response_cache[request_id] = {
            "pages": pages,
            "thinking": thinking,
            "elapsed": elapsed,
            "tokens": usage,
            "user_id": user_id,
            "prompt": shown_prompt,
            "model": (agent.effective_model or session.model or provider_registry.get_active()['model']),
            "params": params,
            "tools_results": agent.tool_results,
            "tool_calls": agent.tool_call_log,
            "tree_text": agent._render_tree(),
            "files": created_files,
            "page_text": page_text,
            "markup": result_markup,
            "chat_id": chat_id,
            "inline_message_id": inline_message_id,
            "created_at": time.time(),
        }

        if inline_message_id:
            await bot.edit_message_text(
                inline_message_id=inline_message_id,
                text=page_text,
                reply_markup=result_markup,
            )
        else:
            if thinking_msg:
                await thinking_msg.delete()
            if chat_id:
                await bot.send_message(chat_id, page_text, reply_markup=result_markup)
                # Заливаем реально созданные файлы (таблицы-изображения, код, архивы)
                # на файлообменник и присылаем ссылки текстом
                if created_files:
                    links = []
                    for f in created_files:
                        fpath = Path(f["filepath"])
                        url = await upload_to_file_host(fpath)
                        if url:
                            links.append(f"{SYM['file']} {TextFormatter.esc(f['name'])} — <a href=\"{url}\">скачать</a>")
                        else:
                            links.append(f"{SYM['error']} {TextFormatter.esc(f['name'])} — не удалось загрузить")
                    await bot.send_message(chat_id, "\n".join(links))

    except Exception as e:
        logger.error(f"Error delivering generated response for user {user_id}: {e}", exc_info=True)
        error_text = (
            f"{SYM['cross']} <b>Ответ получен, но не удалось его показать</b>\n\n"
            f"<code>{TextFormatter.esc(str(e) or type(e).__name__)}</code>"
        )
        await _notify_generation_error(inline_message_id, thinking_msg, chat_id, error_text)
        # Фолбэк: пробуем доставить хотя бы сырой текст ответа без разметки/кнопок,
        # чтобы результат генерации не пропадал полностью из-за проблемы с
        # оформлением (например, невалидный HTML в ответе модели).
        if chat_id and 'answer' in locals() and answer:
            try:
                await bot.send_message(chat_id, answer[:4000], parse_mode=None)
            except Exception as fallback_err:
                logger.error(f"Fallback plain-text delivery also failed for user {user_id}: {fallback_err}")


async def _send_ask_user_questions(
    agent: "XGOAgent",
    query: str,
    params: GenerationParams,
    session: UserSession,
    chat_id: Optional[int],
    inline_message_id: Optional[str],
    thinking_msg: Optional[Message],
    shown_prompt: str,
) -> None:
    """Агент приостановился на ask_user. Присылает 1-5 вопросов отдельными
    сообщениями (каждое со своими кнопками-вариантами + «Свой ответ»),
    сохраняет agent целиком в _paused_agents для продолжения после того как
    юзер ответит на все вопросы. Инлайн-режим не поддерживается (нет
    chat_id для серии сообщений с ForceReply) -- в этом случае агент
    форсированно завершает без вопросов."""
    questions = agent.pending_questions or []
    if not chat_id or not questions:
        # Не можем спросить -- форсируем финализацию без уточнений, чтобы
        # юзер всё равно получил хоть какой-то ответ, а не тишину.
        agent.messages.append({
            "role": "user",
            "content": "[system] Clarifying questions are not available in this context. Make a reasonable assumption and give your final answer now.",
        })
        await process_generation(
            user_id=agent.user_id, query=query, params=params, session=session,
            chat_id=chat_id, inline_message_id=inline_message_id, thinking_msg=thinking_msg,
            display_prompt=shown_prompt, resume_agent=agent,
        )
        return

    pause_id = str(uuid.uuid4())[:12]
    _paused_agents[pause_id] = {
        "agent": agent,
        "user_id": agent.user_id,
        "chat_id": chat_id,
        "query": query,
        "params": params,
        "shown_prompt": shown_prompt,
        "questions": questions,
        "answers": [None] * len(questions),
        "created_at": time.time(),
    }

    try:
        if thinking_msg:
            await thinking_msg.delete()
    except Exception:
        pass

    intro = f"{SYM['decide']} <b>Прежде чем продолжить, уточню:</b>"
    try:
        await bot.send_message(chat_id, intro)
    except Exception as e:
        logger.error(f"Failed to send ask_user intro: {e}")

    for i, q in enumerate(questions):
        text = f"{SYM['leaf']} <b>{i + 1}/{len(questions)}.</b> {TextFormatter.esc(q['text'])}"
        try:
            await bot.send_message(
                chat_id, text,
                reply_markup=KeyboardBuilder.ask_user_buttons(pause_id, i, q.get("options") or []),
            )
        except Exception as e:
            logger.error(f"Failed to send ask_user question {i}: {e}")


    """Единая точка доставки сообщения об ошибке — пробует все доступные
    каналы (inline / thinking_msg / прямая отправка) и не даёт исключению
    при самой отправке потеряться молча."""
    try:
        if inline_message_id:
            await bot.edit_message_text(inline_message_id=inline_message_id, text=error_text)
        elif thinking_msg:
            await thinking_msg.edit_text(error_text)
        elif chat_id:
            await bot.send_message(chat_id, error_text)
    except Exception as notify_err:
        logger.error(f"Failed to deliver error message: {notify_err}", exc_info=True)
# ═══════════════════════════════════════════════════════════════════
# HANDLERS — команды
# ═══════════════════════════════════════════════════════════════════

@router.message(Command("start"))
async def cmd_start(message: Message):
    user_id = message.from_user.id
    if user_id == OWNER_ID:
        await message.answer(
            TextFormatter.format_welcome(True),
            reply_markup=KeyboardBuilder.owner_panel(),
        )
        return
    if state.is_approved(user_id):
        custom = bot_settings.get("start_message", "")
        await message.answer(custom if custom else TextFormatter.format_welcome(True))
        return
    if user_id in state.blocked_users:
        custom = bot_settings.get("blocked_message", "")
        await message.answer(custom if custom else (
            f"{SYM['cross']} <b>Доступ заблокирован</b>\n\n"
            f"Вы находитесь в чёрном списке."
        ))
        return
    custom = bot_settings.get("pending_message", "")
    await message.answer(custom if custom else TextFormatter.format_welcome(False))
    req = PendingRequest(
        request_id=str(uuid.uuid4())[:8],
        user_id=user_id,
        username=message.from_user.username or "",
        first_name=message.from_user.first_name or "Unknown",
        query="/start",
        chat_id=message.chat.id,
        message_id=message.message_id,
    )
    req = state.add_pending_request(req)
    if state.owner_notifications:
        try:
            await bot.send_message(
                OWNER_ID,
                TextFormatter.format_pending_request(req),
                reply_markup=KeyboardBuilder.approval_buttons(req.request_id),
            )
        except Exception as e:
            logger.error(f"Failed to notify owner: {e}")

_ASK_CMD_RE = re.compile(r"^/ask(?:@\w+)?\s*", re.IGNORECASE)

def _extract_ask_query(text: str) -> str:
    return _ASK_CMD_RE.sub("", text or "", count=1).strip()

async def _create_ask_prompt(message: Message, user_id: int, query: str, continue_request_id: Optional[str] = None) -> None:
    """Общая логика /ask после проверки доступа: заводит pending_prompt с
    текущими параметрами сессии и присылает кнопку подтверждения запуска.
    Используется и из cmd_ask, и из «Продолжить» (см. callback_continue).

    continue_request_id: если задан -- это ответ на кнопку «Продолжить» для
    конкретного диалога. В отправляемый модели запрос подмешивается контекст
    предыдущего ответа (юзер видит и подтверждает СВОЙ текст как есть,
    контекст добавляется только в фактический prompt для модели)."""
    prompt_id = str(uuid.uuid4())[:12]
    session = state.get_session(user_id)

    model_query = query
    if continue_request_id:
        prev = _response_cache.get(continue_request_id)
        prev_answer = (prev.get("pages") or [""])[-1] if prev else ""
        if prev_answer:
            model_query = (
                f"[system: continuing the previous answer below] {prev_answer[:1500]}\n\n"
                f"[user continuation/clarification] {query}"
            )

    state.pending_prompts[prompt_id] = {
        "user_id": user_id,
        "query": model_query,
        "display_query": query,
        "chat_id": message.chat.id,
        "created_at": time.time(),
        "params": GenerationParams(
            max_tokens=session.max_tokens,
            temperature=session.temperature,
            top_p=session.top_p,
        ),
        "active_skills": list(session.active_skills),
        "active_tools": list(session.preferred_tools),
    }
    state.save_pending_prompts()

    try:
        await message.answer(
            f"{TextFormatter.format_prompt_block(query)}\n\n"
            f"{SYM['typing']} Нажмите кнопку для запуска:",
            reply_markup=KeyboardBuilder.generate_button(prompt_id),
        )
    except Exception as e:
        logger.error(f"Failed to send confirmation: {e}")
        state.pending_prompts.pop(prompt_id, None)
        await message.answer(
            f"{SYM['cross']} <b>Ошибка</b>\n\n"
            f"<code>{TextFormatter.esc(str(e))}</code>"
        )

@router.message(Command("ask"))
async def cmd_ask(message: Message):
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        if user_id not in state.blocked_users:
            query = _extract_ask_query(message.text) or "(пустой запрос)"
            req = PendingRequest(
                request_id=str(uuid.uuid4())[:8],
                user_id=user_id,
                username=message.from_user.username or "",
                first_name=message.from_user.first_name or "Unknown",
                query=query,
                chat_id=message.chat.id,
                message_id=message.message_id,
            )
            req = state.add_pending_request(req)
            await message.answer(
                f"{SYM['pending']} <b>Ожидайте разрешения владельца</b>\n\n"
                f"Ваш запрос отправлен на рассмотрение.\n"
                f"ID запроса: <code>{req.request_id}</code>"
            )
            if state.owner_notifications:
                try:
                    await bot.send_message(
                        OWNER_ID,
                        TextFormatter.format_pending_request(req),
                        reply_markup=KeyboardBuilder.approval_buttons(req.request_id),
                    )
                except Exception as e:
                    logger.error(f"Failed to notify owner: {e}")
        return

    query = _extract_ask_query(message.text)
    if not query:
        await message.answer(
            f"{SYM['warning']} <b>Укажите запрос</b>\n\n"
            f"Использование: <code>/ask &lt;ваш вопрос&gt;</code>"
        )
        return

    await _create_ask_prompt(message, user_id, query)

@router.message(Command("clear"))
async def cmd_clear(message: Message):
    user_id = message.from_user.id
    if user_id in state.sessions:
        state.sessions[user_id].messages.clear()
    await message.answer(f"{SYM['check']} <b>История очищена</b>")

@router.message(Command("status"))
async def cmd_status(message: Message):
    user_id = message.from_user.id
    session = state.get_session(user_id)
    status_text = (
        f"{SYM['stats']} <b>Статус сессии</b>\n\n"
        f"{SYM['prompt']} Сообщений: <code>{len(session.messages)}</code>\n"
        f"{SYM['time']} Создана: <code>{datetime.fromtimestamp(session.created_at).strftime('%H:%M:%S')}</code>\n"
        f"{SYM['refresh']} Обновлена: <code>{datetime.fromtimestamp(session.updated_at).strftime('%H:%M:%S')}</code>\n"
        f"{SYM['speed']} Температура: <code>{session.temperature}</code>\n"
        f"{SYM['tokens']} Max Tokens: <code>{session.max_tokens}</code>\n"
        f"{SYM['decide']} Top-P: <code>{session.top_p}</code>\n"
        f"{SYM['skill']} Активные скиллы: <code>{', '.join(session.active_skills) or 'нет'}</code>\n"
        f"{SYM['tool']} Активные тулы: <code>{', '.join(session.preferred_tools)}</code>\n"
        f"{SYM['brain']} Модель: <code>{provider_registry.get_active()['model']}</code>"
    )
    await message.answer(status_text)

@router.message(Command("settings"))
async def cmd_settings(message: Message):
    """Раньше /settings был просто текстом с подписью «меняйте кнопками при
    отправке запроса» -- то есть реально поменять что-то можно было только
    из-под уже сгенерированного ответа. Теперь это те же самые кнопки
    (температура/токены/top-p/тулы), тот же механизм guard_callback_owner +
    pending_prompts, что и у «Продолжить»/«Файлы» и остальных -- просто
    привязанные к «пустому» pending-промпту, который никогда не запускается
    на генерацию, а только хранит параметры сессии. TTL-очистка (см.
    _cleanup_expired_caches) сама подчистит такие записи."""
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        await message.answer(f"{SYM['lock']} <b>Доступ ограничен</b>")
        return
    session = state.get_session(user_id)

    prompt_id = str(uuid.uuid4())[:12]
    state.pending_prompts[prompt_id] = {
        "user_id": user_id,
        "query": "(настройки сессии)",
        "chat_id": message.chat.id,
        "created_at": time.time(),
        "params": GenerationParams(
            max_tokens=session.max_tokens,
            temperature=session.temperature,
            top_p=session.top_p,
        ),
        "active_skills": list(session.active_skills),
        "active_tools": list(session.preferred_tools),
    }
    state.save_pending_prompts()

    settings_text = (
        f"{SYM['settings']} <b>Настройки генерации</b>\n\n"
        f"{SYM['diamond']} Модель: <code>{TextFormatter.esc(session.model or provider_registry.get_active()['model'])}</code>\n"
        f"{SYM['speed']} Температура: <code>{session.temperature}</code>\n"
        f"{SYM['tokens']} Max Tokens: <code>{session.max_tokens}</code>\n"
        f"{SYM['decide']} Top-P: <code>{session.top_p}</code>\n"
        f"{SYM['tool']} Тулы: <code>{', '.join(session.preferred_tools) or 'нет'}</code>\n\n"
        f"Выберите параметр:"
    )
    await message.answer(settings_text, reply_markup=KeyboardBuilder.settings_params_buttons(prompt_id))

@router.message(Command("skills"))
async def cmd_skills(message: Message):
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        await message.answer(f"{SYM['lock']} <b>Доступ ограничен</b>")
        return
    
    session = state.get_session(user_id)
    skills = state.skill_manager.list_skills()
    
    text = f"{SYM['skill']} <b>Доступные скиллы</b>\n\n"
    for skill in skills:
        status = SYM["check"] if skill.name in session.active_skills else SYM["cross"]
        text += f"{status} {skill.icon} <b>{skill.name}</b> — {skill.description}\n"
    
    text += "\nДля активации используйте кнопки в меню запроса."
    await message.answer(text)

@router.message(Command("tools"))
async def cmd_tools(message: Message):
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        await message.answer(f"{SYM['lock']} <b>Доступ ограничен</b>")
        return
    
    tools = state.tool_manager.list_tools()
    text = f"{SYM['tool']} <b>Доступные тулы</b>\n\n"
    for tool in tools:
        text += f"{tool.icon} <b>{tool.name}</b> — {tool.description}\n"
    
    text += "\nТулы активируются автоматически по ключевым словам в запросе."
    await message.answer(text)


@router.message(Command("model"))
async def cmd_model(message: Message):
    """Позволяет обычному (одобренному) юзеру выбрать модель для СВОИХ
    запросов -- независимо от того, какая модель сейчас активна глобально
    в панели. Выбор живёт в session.model и переживает до явной смены или
    сброса истории по TTL (см. BotState.get_session)."""
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        await message.answer(f"{SYM['lock']} <b>Доступ ограничен</b>")
        return

    session = state.get_session(user_id)
    current_model = session.model or provider_registry.get_active()["model"]
    providers = provider_registry.list()
    if not providers:
        await message.answer(f"{SYM['warning']} Ни одна модель пока не настроена.")
        return

    rows = []
    for p in providers:
        mark = f"{SYM['check']} " if p["model"] == current_model else ""
        rows.append([InlineKeyboardButton(text=f"{mark}{p['model']}", callback_data=f"set_model:{p['id']}")])
    await message.answer(
        f"{SYM['brain']} <b>Выбор модели</b>\n\n"
        f"Сейчас у вас: <code>{TextFormatter.esc(current_model)}</code>\n\n"
        f"Выберите модель для своих запросов:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows),
    )


@router.callback_query(F.data.startswith("set_model:"))
async def callback_set_model(callback: CallbackQuery):
    user_id = callback.from_user.id
    if not state.is_approved(user_id):
        await callback.answer("Нет доступа", show_alert=True)
        return
    provider_id = callback.data.split(":", 1)[1]
    p = provider_registry.get(provider_id)
    if not p:
        await callback.answer("Эта модель больше недоступна", show_alert=True)
        return
    session = state.get_session(user_id)
    session.model = p["model"]
    await callback.answer(f"Модель переключена: {p['model']}")
    try:
        await callback.message.edit_text(
            f"{SYM['check']} <b>Модель обновлена</b>\n\n"
            f"Теперь ваши запросы используют: <code>{TextFormatter.esc(p['model'])}</code>"
        )
    except Exception:
        pass


def _github_menu_keyboard(connected: bool) -> InlineKeyboardMarkup:
    rows = []
    if connected:
        rows.append([InlineKeyboardButton(text=f"{SYM['check']} Проверить подключение", callback_data="gh_test")])
        rows.append([InlineKeyboardButton(text=f"{SYM['error']} Отключить репозиторий", callback_data="gh_disconnect")])
    else:
        rows.append([InlineKeyboardButton(text=f"{SYM['link']} Подключить репозиторий", callback_data="gh_connect_start")])
    return InlineKeyboardMarkup(inline_keyboard=rows)

def _branch_selector_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="main", callback_data="gh_branch:main"),
            InlineKeyboardButton(text="master", callback_data="gh_branch:master"),
        ],
        [InlineKeyboardButton(text=f"{SYM['pointer']} Другая ветка", callback_data="gh_branch:custom")],
        [InlineKeyboardButton(text=f"{SYM['cross']} Отмена", callback_data="gh_cancel_setup")],
    ])

def _github_status_text(conn: Optional[GitHubConnection]) -> str:
    if not conn:
        return (
            f"{SYM['tool']} <b>GitHub — подключение</b>\n\n"
            f"Репозиторий не подключён.\n\n"
            f"Подключив репозиторий, бот сможет:\n"
            f"  {SYM['pointer']} создавать и обновлять файлы в нём (github_commit)\n"
            f"  {SYM['pointer']} смотреть структуру и файлы репозитория (github_read)\n"
            f"  {SYM['pointer']} запускать GitHub Actions workflow и проверять их статус (github_actions)\n\n"
            f"Понадобится Personal Access Token с правами <code>repo</code> "
            f"(создать: GitHub → Settings → Developer settings → Personal access tokens)."
        )
    return (
        f"{SYM['tool']} <b>GitHub — подключение</b>\n\n"
        f"{SYM['check']} Подключён репозиторий: <code>{TextFormatter.esc(conn.owner)}/{TextFormatter.esc(conn.repo)}</code>\n"
        f"Ветка: <code>{TextFormatter.esc(conn.branch)}</code>\n"
        f"Токен: <code>{TextFormatter.esc(conn.token[:7])}...{TextFormatter.esc(conn.token[-4:])}</code>"
    )

async def _finalize_github_connection(
    message_or_none, user_id: int, session: "UserSession", setup: dict, branch: str, edit_via: Optional[CallbackQuery] = None
):
    """Общая точка завершения подключения: используется и при выборе ветки
    кнопкой, и при вводе кастомной ветки текстом."""
    conn = GitHubConnection(
        user_id=user_id,
        token=setup["token"],
        owner=setup["owner"],
        repo=setup["repo"],
        branch=branch,
    )
    session.github_setup = None

    status_text = f"{SYM['pending']} Проверяю подключение..."
    if edit_via:
        await safe_edit(edit_via, status_text)
        status_msg = edit_via.message
    else:
        status_msg = await message_or_none.answer(status_text)

    client = GitHubClient(conn.token, conn.owner, conn.repo, conn.branch)
    ok, test_msg = await client.test_connection()

    if ok:
        state.set_github_connection(conn)
        final_text = f"{_github_status_text(conn)}\n\n{SYM['check']} <b>Подключено успешно!</b>\n{TextFormatter.esc(test_msg)}"
        final_markup = _github_menu_keyboard(True)
    else:
        final_text = (
            f"{SYM['error']} <b>Не удалось подключиться</b>\n\n{TextFormatter.esc(test_msg)}\n\n"
            f"Проверьте токен и права доступа, затем запустите /github снова."
        )
        final_markup = None

    try:
        await status_msg.edit_text(final_text, reply_markup=final_markup)
    except Exception as e:
        logger.error(f"Failed to edit github setup final message: {e}")

@router.message(Command("github"))
async def cmd_github(message: Message):
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        await message.answer(f"{SYM['lock']} <b>Доступ ограничен</b>")
        return
    conn = state.get_github_connection(user_id)
    await message.answer(_github_status_text(conn), reply_markup=_github_menu_keyboard(conn is not None))

@router.callback_query(F.data == "gh_connect_start")
async def callback_gh_connect_start(callback: CallbackQuery):
    user_id = callback.from_user.id
    session = state.get_session(user_id)
    session.github_setup = {"step": "token_repo"}
    cancel_markup = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"{SYM['cross']} Отмена", callback_data="gh_cancel_setup")],
    ])
    await safe_edit(
        callback,
        f"{SYM['tool']} <b>Подключение GitHub — шаг 1/2</b>\n\n"
        f"Отправьте одним сообщением: <b>токен</b> и <b>репозиторий</b> через пробел:\n"
        f"<code>ghp_ваштокен owner/repo</code>\n\n"
        f"Например: <code>ghp_abc123 torvalds/linux</code>\n\n"
        f"{SYM['warning']} Сообщение с токеном будет автоматически удалено после отправки.",
        reply_markup=cancel_markup,
    )
    await callback.answer()

@router.callback_query(F.data == "gh_cancel_setup")
async def callback_gh_cancel_setup(callback: CallbackQuery):
    user_id = callback.from_user.id
    session = state.get_session(user_id)
    session.github_setup = None
    conn = state.get_github_connection(user_id)
    await safe_edit(callback, _github_status_text(conn), reply_markup=_github_menu_keyboard(conn is not None))
    await callback.answer("Подключение отменено")

@router.callback_query(F.data == "gh_disconnect")
async def callback_gh_disconnect(callback: CallbackQuery):
    user_id = callback.from_user.id
    state.remove_github_connection(user_id)
    await safe_edit(
        callback,
        _github_status_text(None),
        reply_markup=_github_menu_keyboard(False),
    )
    await callback.answer("Репозиторий отключён")

@router.callback_query(F.data.startswith("gh_branch:"))
async def callback_gh_branch(callback: CallbackQuery):
    user_id = callback.from_user.id
    session = state.get_session(user_id)
    setup = session.github_setup
    if not setup or setup.get("step") != "branch":
        await callback.answer("Сессия подключения устарела, начните заново через /github", show_alert=True)
        return

    branch = callback.data.split(":", 1)[1]
    if branch == "custom":
        setup["step"] = "branch_custom"
        session.github_setup = setup
        cancel_markup = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text=f"{SYM['cross']} Отмена", callback_data="gh_cancel_setup")],
        ])
        await safe_edit(callback, f"{SYM['tool']} Отправьте название ветки текстом", reply_markup=cancel_markup)
        await callback.answer()
        return

    await _finalize_github_connection(callback.message, user_id, session, setup, branch, edit_via=callback)
    await callback.answer()

@router.callback_query(F.data == "gh_test")
async def callback_gh_test(callback: CallbackQuery):
    user_id = callback.from_user.id
    conn = state.get_github_connection(user_id)
    if not conn:
        await callback.answer("Репозиторий не подключён", show_alert=True)
        return
    await callback.answer("Проверяю подключение...")
    client = GitHubClient(conn.token, conn.owner, conn.repo, conn.branch)
    ok, msg = await client.test_connection()
    icon = SYM['check'] if ok else SYM['error']
    await safe_edit(
        callback,
        f"{_github_status_text(conn)}\n\n{icon} <b>Проверка:</b> {TextFormatter.esc(msg)}",
        reply_markup=_github_menu_keyboard(True),
    )

@router.message(Command("help"))
async def cmd_help(message: Message):
    help_text = (
        f"{SYM['bot']} <b>XGO v2.0 — Справка</b>\n\n"
        f"<b>Основные команды:</b>\n"
        f"<code>/ask &lt;вопрос&gt;</code> — задать вопрос ИИ\n"
        f"<code>/clear</code> — очистить историю чата\n"
        f"<code>/status</code> — статус текущей сессии\n"
        f"<code>/settings</code> — настройки параметров\n"
        f"<code>/skills</code> — список скиллов\n"
        f"<code>/tools</code> — список тулов\n"
        f"<code>/model</code> — выбрать модель для своих запросов\n"
        f"<code>/github</code> — подключить GitHub-репозиторий\n"
        f"<code>/mods</code> — список подключённых модулей (с других серверов)\n"
        f"<code>/help</code> — эта справка\n\n"
        f"<b>Функции:</b>\n"
        f"{SYM['think']} Гибкое дерево размышлений перед ответом\n"
        f"{SYM['page']} Пагинация длинных ответов\n"
        f"{SYM['arrow']} Работа в любом чате через inline\n"
        f"{SYM['code']} Markdown форматирование\n"
        f"{SYM['tool']} Автоматические тулы (поиск, файлы, таблицы, графики, презентации, exec, GitHub)\n"
        f"{SYM['skill']} Система скиллов для разных задач\n"
        f"{SYM['speed']} Настраиваемая температура и max_tokens\n\n"
        f"<b>Владелец:</b>\n"
        f"{SYM['lock']} Контроль доступа пользователей\n"
        f"{SYM['stats']} Статистика использования\n"
        f"{SYM['queue']} Управление очередью\n\n"
        f"{SYM['brain']} Текущая модель: <code>{provider_registry.get_active()['model']}</code>"
    )
    await message.answer(help_text)


@router.message(F.text.startswith("/"))
async def handle_custom_command(message: Message):
    """Ловит слэш-команды, добавленные владельцем через панель (вкладка
    «Команды»). Регистрируется ПОСЛЕ всех встроенных Command(...)-хендлеров
    выше, поэтому /start, /ask и т.д. этот обработчик никогда не видит --
    aiogram останавливается на первом хендлере, чей фильтр совпал.

    Команда с текстовым ответом -- просто отправляет его. Команда,
    привязанная к моду, работает как /ask (та же кнопка подтверждения
    запуска), только к запросу добавляется явная подсказка, каким модом
    предпочтительно воспользоваться -- решение всё равно остаётся за
    агентом (мы не форсим конкретный тул-вызов на уровне рантайма)."""
    user_id = message.from_user.id
    cmd_name = (message.text or "").split()[0].split("@")[0]
    entry = command_registry.find(cmd_name)
    if not entry or not entry.get("enabled"):
        return  # неизвестная команда -- бот молчит, как и раньше

    if not state.is_approved(user_id):
        if user_id not in state.blocked_users:
            await message.answer(
                f"{SYM['pending']} <b>Ожидайте разрешения владельца</b>\n\n"
                f"Команда <code>{entry['name']}</code> доступна только одобренным пользователям."
            )
        return

    if entry.get("response"):
        await message.answer(entry["response"])
        return

    rest = message.text.split(maxsplit=1)
    arg = rest[1] if len(rest) > 1 else ""
    mod = mod_registry.mods.get(entry["mod_id"])
    mod_hint = f" (используй модуль «{mod.title}»)" if mod else ""
    query = f"{entry['description'] or entry['name']}{mod_hint}" + (f": {arg}" if arg else "")

    prompt_id = str(uuid.uuid4())[:12]
    session = state.get_session(user_id)
    state.pending_prompts[prompt_id] = {
        "user_id": user_id,
        "query": query,
        "chat_id": message.chat.id,
        "created_at": time.time(),
        "params": GenerationParams(
            max_tokens=session.max_tokens,
            temperature=session.temperature,
            top_p=session.top_p,
        ),
        "active_skills": list(session.active_skills),
        "active_tools": list(session.preferred_tools),
    }
    state.save_pending_prompts()
    await message.answer(
        f"{TextFormatter.format_prompt_block(query)}\n\n"
        f"{SYM['typing']} Нажмите кнопку для запуска:",
        reply_markup=KeyboardBuilder.generate_button(prompt_id),
    )


# ═══════════════════════════════════════════════════════════════════
# CALLBACK HANDLERS — генерация и навигация
# ═══════════════════════════════════════════════════════════════════

@router.callback_query(F.data.startswith("generate:"))
async def callback_generate(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    user_id = callback.from_user.id
    query = data["query"]
    params = data["params"]
    session = state.get_session(user_id)
    inline = is_inline_callback(callback)

    await callback.answer()

    thinking_text = f"{SYM['think']} <b>XGO анализирует запрос</b>..."
    thinking_msg = None
    if inline:
        await bot.edit_message_text(inline_message_id=callback.inline_message_id, text=thinking_text)
    else:
        # Раньше здесь было callback.message.delete() — физическое удаление
        # сообщения с кнопками "Скиллы"/"Параметры". Из-за этого, если
        # пользователь успевал нажать одну из них чуть позже (например, уже
        # после того как результат пришёл, чтобы подправить параметры и
        # перегенерировать), кнопка указывала на удалённое сообщение и/или на
        # уже выпиленный из pending_prompts prompt_id — гарантированное
        # "кнопка устарела" сразу при нажатии. Теперь просто редактируем текст
        # на "думает", сообщение и prompt_id остаются рабочими.
        await callback.message.edit_text(thinking_text)
        thinking_msg = callback.message

    await process_generation(
        user_id=user_id,
        query=query,
        params=params,
        session=session,
        chat_id=callback.message.chat.id if callback.message else None,
        inline_message_id=callback.inline_message_id if inline else None,
        thinking_msg=thinking_msg,
    )
    # prompt_id больше не выпиливается сразу — он просто истечёт по обычному
    # TTL (_cleanup_expired_caches), как и все остальные pending_prompts. Это
    # позволяет вернуться к "Параметры"/"Скиллы" после генерации и запросить
    # повторную генерацию с изменёнными настройками через тот же prompt_id.

@router.callback_query(F.data.startswith("page:"))
async def callback_pagination(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id, page_num = parts
    try:
        page_num = int(page_num)
    except ValueError:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return
    pages = data["pages"]
    total_pages = len(pages)
    if page_num < 1 or page_num > total_pages:
        await callback.answer("Некорректная страница")
        return
    page_text = TextFormatter.format_full_response(
        prompt=data.get("prompt", ""),
        thinking=data.get("thinking", ""),
        answer=pages[page_num - 1],
        elapsed=data.get("elapsed", 0),
        tokens=data.get("tokens", {}),
        page_num=page_num,
        total_pages=total_pages,
        model=data.get("model", provider_registry.get_active()['model']),
        tools_results=data.get("tools_results", []),
    )
    result_markup = KeyboardBuilder.pagination_buttons(page_num, total_pages, request_id)
    data["page_text"] = page_text
    data["markup"] = result_markup
    await safe_edit(callback, page_text, reply_markup=result_markup)
    await callback.answer()

async def _record_ask_user_answer(pause_id: str, q_idx: int, answer_text: str) -> Optional[dict]:
    """Записывает ответ юзера на вопрос q_idx паузы pause_id. Возвращает
    состояние паузы, если ВСЕ вопросы уже отвечены (готово к резюме), иначе
    None (ждём остальные ответы)."""
    paused = _paused_agents.get(pause_id)
    if not paused:
        return None
    answers = paused["answers"]
    if 0 <= q_idx < len(answers):
        answers[q_idx] = answer_text
    if all(a is not None for a in answers):
        return paused
    return None

async def _resume_paused_agent(pause_id: str, paused: dict) -> None:
    """Все вопросы отвечены -- дописывает ответы в контекст модели одним
    системным сообщением и продолжает _tool_loop с того же места, где агент
    остановился (тот же messages/tree_nodes/tool_call_log)."""
    _paused_agents.pop(pause_id, None)
    agent: XGOAgent = paused["agent"]
    questions = paused["questions"]
    answers = paused["answers"]

    lines = [f"- {q['text']} -> {a}" for q, a in zip(questions, answers)]
    agent.messages.append({
        "role": "user",
        "content": "[system: user answered your questions]\n" + "\n".join(lines),
    })
    for node in agent.tree_nodes:
        if node.get("state") == "active":
            node["state"] = "done"
    agent._push_node(f"{SYM['check']} Получены ответы на уточнения", state="done")
    await agent._status(force=True)

    chat_id = paused["chat_id"]
    thinking_msg = None
    try:
        thinking_msg = await bot.send_message(chat_id, f"{SYM['think']} <b>XGO продолжает</b>...")
    except Exception as e:
        logger.error(f"Failed to send resume thinking message: {e}")

    await process_generation(
        user_id=paused["user_id"],
        query=paused["query"],
        params=paused["params"],
        session=state.get_session(paused["user_id"]),
        chat_id=chat_id,
        inline_message_id=None,
        thinking_msg=thinking_msg,
        display_prompt=paused["shown_prompt"],
        resume_agent=agent,
    )

@router.callback_query(F.data.startswith("askans:"))
async def callback_ask_user_answer(callback: CallbackQuery):
    """Юзер нажал одну из кнопок-вариантов на вопросе ask_user."""
    parts = parse_callback_data(callback, 4)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, pause_id, q_idx_str, opt_idx_str = parts
    paused = _paused_agents.get(pause_id)
    if not paused or paused["user_id"] != callback.from_user.id:
        await callback.answer("Данные устарели или это не ваш диалог", show_alert=True)
        return
    try:
        q_idx, opt_idx = int(q_idx_str), int(opt_idx_str)
        options = paused["questions"][q_idx].get("options") or []
        answer_text = options[opt_idx]
    except (ValueError, IndexError):
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return

    await callback.answer(f"Ответ принят: {answer_text[:40]}")
    try:
        await safe_edit(callback, callback.message.html_text + f"\n\n{SYM['check']} <i>{TextFormatter.esc(answer_text)}</i>", reply_markup=None)
    except Exception:
        pass

    ready = await _record_ask_user_answer(pause_id, q_idx, answer_text)
    if ready:
        await _resume_paused_agent(pause_id, ready)

@router.callback_query(F.data.startswith("askinput:"))
async def callback_ask_user_input(callback: CallbackQuery):
    """Кнопка «Свой ответ»: открывает ForceReply, привязанный к
    (pause_id, q_idx) через session.awaiting_ask_user."""
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, pause_id, q_idx_str = parts
    paused = _paused_agents.get(pause_id)
    if not paused or paused["user_id"] != callback.from_user.id:
        await callback.answer("Данные устарели или это не ваш диалог", show_alert=True)
        return
    try:
        q_idx = int(q_idx_str)
    except ValueError:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return

    chat_id = callback.message.chat.id if callback.message else paused["chat_id"]
    session = state.get_session(callback.from_user.id)
    session.awaiting_ask_user = (pause_id, q_idx)
    await callback.answer()
    await bot.send_message(
        chat_id,
        f"{SYM['typing']} Напишите свой ответ на вопрос {q_idx + 1}:",
        reply_markup=ForceReply(selective=True, input_field_placeholder="Ваш ответ..."),
    )

@router.callback_query(F.data.startswith("continue:"))
async def callback_continue(callback: CallbackQuery):
    """Кнопка «Продолжить»: раньше сама генерировала автоматический
    "continue from where you left off" промпт без участия юзера. Теперь
    вместо этого открывает ForceReply-инпут (как раньше делала отдельная
    кнопка «Ввести запрос», которую убрали как дублирующую) -- юзер сам
    пишет, ЧТО именно продолжить/уточнить, и это уходит в контекст ИМЕННО
    этого диалога (request_id), а не как новый безымянный /ask.
    Работает только в обычном чате -- в инлайн-режиме у бота нет chat_id,
    чтобы прислать ForceReply-приглашение с клавиатурой."""
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    chat_id = callback.message.chat.id if callback.message else data.get("chat_id")
    if not chat_id:
        await callback.answer("В инлайн-режиме так нельзя -- напишите боту в личку /ask", show_alert=True)
        return

    user_id = callback.from_user.id
    session = state.get_session(user_id)
    session.awaiting_input = True
    session.awaiting_continue_request_id = request_id
    await callback.answer()
    await bot.send_message(
        chat_id,
        f"{SYM['continue']} Напишите, что продолжить или уточнить по этому диалогу -- "
        f"ответ уйдёт с учётом предыдущего сообщения, набирать команду не нужно.",
        reply_markup=ForceReply(selective=True, input_field_placeholder="Что продолжить/уточнить..."),
    )
@router.callback_query(F.data.startswith("regen_prompt:"))
async def callback_regen_with_prompt(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    user_id = callback.from_user.id
    prompt = data.get("prompt", "")
    params = data.get("params", GenerationParams())

    prompt_id = str(uuid.uuid4())[:12]
    state.pending_prompts[prompt_id] = {
        "user_id": user_id,
        "query": prompt,
        "chat_id": callback.message.chat.id if callback.message else None,
        "created_at": time.time(),
        "params": params,
        "active_skills": list(state.get_session(user_id).active_skills),
    }
    state.save_pending_prompts()

    await safe_edit(callback,
        f"{TextFormatter.format_prompt_block(prompt)}\n\n"
        f"{SYM['typing']} Нажмите для повторной генерации:",
        reply_markup=KeyboardBuilder.generate_button(prompt_id),
    )
    await callback.answer()

@router.callback_query(F.data.startswith("regen:"))
async def callback_regenerate(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    user_id = callback.from_user.id
    prompt = data.get("prompt", "")
    params = data.get("params", GenerationParams())
    session = state.get_session(user_id)

    inline = is_inline_callback(callback)
    await safe_edit(callback, f"{SYM['think']} <b>Перегенерация</b>...")

    await process_generation(
        user_id=user_id,
        query=prompt,
        params=params,
        session=session,
        chat_id=callback.message.chat.id if callback.message else None,
        inline_message_id=callback.inline_message_id if inline else None,
        thinking_msg=callback.message if (not inline and callback.message) else None,
    )

@router.callback_query(F.data.startswith("clear:"))
async def callback_clear(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return
    user_id = callback.from_user.id
    if user_id in state.sessions:
        state.sessions[user_id].messages.clear()
    await safe_edit(callback, f"{SYM['check']} <b>История очищена</b>")
    await callback.answer()

@router.callback_query(F.data.startswith("history:"))
async def callback_history(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return
    user_id = callback.from_user.id
    session = state.get_session(user_id)

    if not session.messages:
        await callback.answer("История пуста", show_alert=True)
        return

    history_text = f"{SYM['history']} <b>История чата</b>\n\n"
    for i, msg in enumerate(session.messages[-10:]):
        role_icon = SYM['prompt'] if msg['role'] == 'user' else SYM['answer']
        content = msg['content'][:150] + "..." if len(msg['content']) > 150 else msg['content']
        history_text += f"{role_icon} <b>{msg['role'].capitalize()}:</b> {TextFormatter.esc(content)}\n\n"

    await safe_send_extra(callback, history_text)
    await callback.answer()

LOG_PAGE_SIZE = 12  # записей лога на страницу
LOG_QUOTE_THRESHOLD = 60  # длина превью аргументов, после которой заворачиваем в expandable-цитату

def _format_log_lines(tool_calls: List[Dict]) -> List[str]:
    """Короткие вызовы -- одна строка как раньше. Длинные (много/большие
    аргументы) заворачиваем в <blockquote expandable>, чтобы полная
    сигнатура вызова была доступна по тапу, а свёрнутый вид не растягивал
    сообщение постранично -- то же самое, что и в дереве размышлений."""
    lines = []
    for tc in tool_calls:
        tool_name = tc.get("tool", "unknown")
        args = tc.get("args", {})
        args_preview_short = ", ".join(f"{k}={XGOAgent._preview_arg_value(v)}" for k, v in list(args.items())[:3])
        header = f"{SYM['tool']} <code>{TextFormatter.esc(tool_name)}</code>"
        if len(args_preview_short) <= LOG_QUOTE_THRESHOLD:
            lines.append(f"{header}(<code>{TextFormatter.esc(args_preview_short)}</code>)")
        else:
            args_full = ", ".join(f"{k}={XGOAgent._preview_arg_value(v, max_len=400)}" for k, v in args.items())
            lines.append(
                f"{header}\n<blockquote expandable><code>{TextFormatter.esc(args_full)}</code></blockquote>"
            )
    return lines

def _paginate_lines(lines: List[str], page: int) -> Tuple[List[str], int, int]:
    total_pages = max(1, math.ceil(len(lines) / LOG_PAGE_SIZE)) if lines else 1
    page = max(0, min(page, total_pages - 1))
    start = page * LOG_PAGE_SIZE
    return lines[start:start + LOG_PAGE_SIZE], page, total_pages

@router.callback_query(F.data.startswith("log:"))
async def callback_log(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    lines = _format_log_lines(data.get("tool_calls") or [])
    if not lines:
        text = f"{SYM['process']} <b>Лог действий</b>\n\nТулы в этом ответе не вызывались."
        await safe_edit(
            callback, text,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text=f"{SYM['root']} Назад к дереву", callback_data=f"tree:{request_id}")],
            ]),
        )
        await callback.answer()
        return
    chunk, page, total_pages = _paginate_lines(lines, 0)
    text = f"{SYM['process']} <b>Лог действий</b>\n\n" + "\n".join(chunk)
    await safe_edit(callback, text, reply_markup=KeyboardBuilder.log_page_buttons(request_id, page, total_pages))
    await callback.answer()

@router.callback_query(F.data.startswith("logpage:"))
async def callback_log_page(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id, page_str = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return
    try:
        page = int(page_str)
    except ValueError:
        page = 0

    lines = _format_log_lines(data.get("tool_calls") or [])
    chunk, page, total_pages = _paginate_lines(lines, page)
    text = f"{SYM['process']} <b>Лог действий</b>\n\n" + "\n".join(chunk)
    await safe_edit(callback, text, reply_markup=KeyboardBuilder.log_page_buttons(request_id, page, total_pages))
    await callback.answer()

@router.callback_query(F.data == "noop")
async def callback_noop(callback: CallbackQuery):
    await callback.answer()

TREE_PAGE_SIZE = 12  # строк дерева на страницу

TREE_QUOTE_THRESHOLD = 70  # длина строки узла, после которой она сворачивается в expandable-цитату

def _collapse_long_tree_line(line: str) -> str:
    """Заворачивает длинную метку узла в <blockquote expandable>, оставляя
    коннектор (├─/└─) и иконку статуса снаружи цитаты -- визуально дерево
    остаётся деревом, а не превращается в список цитат. Живой статус во
    время генерации это НЕ трогает (там нужен быстрый edit_text без риска
    сломать частые перерисовки) -- сворачивание применяется только здесь,
    при просмотре готового дерева по кнопке."""
    if len(line) <= TREE_QUOTE_THRESHOLD:
        return line
    m = re.match(r"^(\s*(?:├─|└─)\s*\S+\s*)(.*)$", line)
    if not m:
        return line
    prefix, label = m.group(1), m.group(2)
    return f"{prefix}\n<blockquote expandable>{label}</blockquote>"

def _paginate_tree(tree_text: str, page: int) -> Tuple[str, str, int, int]:
    """Header (первая строка "XGO Agent · рассуждаю...") показываем на
    каждой странице, а сами узлы режем по TREE_PAGE_SIZE -- иначе длинный
    прогон (много тулов/шагов) не влезает в одно сообщение Telegram.
    Длинные узлы дополнительно сворачиваются в expandable-цитаты."""
    lines = tree_text.split("\n")
    header = lines[0] if lines else f"{SYM['root']} <b>XGO Agent</b>"
    body = lines[1:]
    total_pages = max(1, math.ceil(len(body) / TREE_PAGE_SIZE)) if body else 1
    page = max(0, min(page, total_pages - 1))
    start = page * TREE_PAGE_SIZE
    page_lines = [_collapse_long_tree_line(l) for l in body[start:start + TREE_PAGE_SIZE]]
    chunk = "\n".join(page_lines)
    return header, chunk, page, total_pages

@router.callback_query(F.data.startswith("tree:"))
async def callback_tree(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    tree_text = data.get("tree_text") or f"{SYM['root']} Дерево рассуждений недоступно для этого ответа"
    header, chunk, page, total_pages = _paginate_tree(tree_text, 0)
    text = f"{SYM['root']} <b>Дерево рассуждений</b>\n\n{header}\n{chunk}"
    await safe_edit(callback, text, reply_markup=KeyboardBuilder.tree_page_buttons(request_id, page, total_pages))
    await callback.answer()

@router.callback_query(F.data.startswith("treepage:"))
async def callback_tree_page(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id, page_str = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return
    try:
        page = int(page_str)
    except ValueError:
        page = 0

    tree_text = data.get("tree_text") or f"{SYM['root']} Дерево рассуждений недоступно для этого ответа"
    header, chunk, page, total_pages = _paginate_tree(tree_text, page)
    text = f"{SYM['root']} <b>Дерево рассуждений</b>\n\n{header}\n{chunk}"
    await safe_edit(callback, text, reply_markup=KeyboardBuilder.tree_page_buttons(request_id, page, total_pages))
    await callback.answer()

async def upload_to_file_host(file_path: Path) -> Optional[str]:
    """Заливает файл на публичный файлообменник и возвращает прямую ссылку.
    Пробует несколько сервисов по очереди на случай, если один недоступен."""
    data = file_path.read_bytes()
    filename = file_path.name
    # Некоторые файлообменники (например 0x0.st) режут запросы с дефолтным
    # User-Agent библиотек как "бота" — представляемся как curl, это разрешённый
    # и ожидаемый клиент для таких сервисов (их же примеры используют curl).
    headers = {"User-Agent": "curl/8.5.0"}

    async with aiohttp.ClientSession(headers=headers) as session:
        # kappa.lol — первым: лимит на файл заметно больше (порядка 1GB
        # против ~512MB у 0x0.st/x0.at). POST multipart, поле "file",
        # в ответ JSON с прямой ссылкой в "url" (либо голый URL текстом).
        try:
            form = aiohttp.FormData()
            form.add_field("file", data, filename=filename)
            async with session.post("https://kappa.lol/api/upload", data=form, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                raw = (await resp.text()).strip()
                if resp.status == 200:
                    url = None
                    try:
                        parsed = json.loads(raw)
                        url = parsed.get("url") or parsed.get("link")
                    except Exception:
                        if raw.startswith("http"):
                            url = raw
                    if url:
                        return url
                logger.error(f"Upload to kappa.lol returned status={resp.status} body={raw[:200]!r}")
        except Exception as e:
            logger.error(f"Upload to kappa.lol failed: {e}")

        # x0.at — тот же простой паттерн, что и 0x0.st: POST multipart с полем
        # "file", ответ — голый URL текстом
        try:
            form = aiohttp.FormData()
            form.add_field("file", data, filename=filename)
            async with session.post("https://x0.at", data=form, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                body = (await resp.text()).strip()
                if resp.status == 200 and body.startswith("http"):
                    return body
                logger.error(f"Upload to x0.at returned status={resp.status} body={body[:200]!r}")
        except Exception as e:
            logger.error(f"Upload to x0.at failed: {e}")

        # 0x0.st — простой POST multipart, возвращает голый URL в теле ответа
        try:
            form = aiohttp.FormData()
            form.add_field("file", data, filename=filename)
            async with session.post("https://0x0.st", data=form, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                body = (await resp.text()).strip()
                if resp.status == 200 and body.startswith("http"):
                    return body
                logger.error(f"Upload to 0x0.st returned status={resp.status} body={body[:200]!r}")
        except Exception as e:
            logger.error(f"Upload to 0x0.st failed: {e}")

        # catbox.moe — тоже multipart, но с полем reqtype
        try:
            form = aiohttp.FormData()
            form.add_field("reqtype", "fileupload")
            form.add_field("fileToUpload", data, filename=filename)
            async with session.post("https://catbox.moe/user/api.php", data=form, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                body = (await resp.text()).strip()
                if resp.status == 200 and body.startswith("http"):
                    return body
                logger.error(f"Upload to catbox.moe returned status={resp.status} body={body[:200]!r}")
        except Exception as e:
            logger.error(f"Upload to catbox.moe failed: {e}")

    return None

def _files_list_keyboard(request_id: str, files: List[Dict[str, str]]) -> InlineKeyboardMarkup:
    """Кнопки с номерами файлов, по 4 в ряд, плюс кнопка назад к ответу."""
    rows = []
    row = []
    for i, f in enumerate(files, 1):
        row.append(InlineKeyboardButton(text=str(i), callback_data=f"file_open:{request_id}:{i - 1}"))
        if len(row) == 4:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    rows.append([InlineKeyboardButton(text=f"{SYM['back']} К ответу", callback_data=f"backresult:{request_id}")])
    return InlineKeyboardMarkup(inline_keyboard=rows)

def _files_list_text(files: List[Dict[str, str]]) -> str:
    if not files:
        return f"{SYM['file']} <b>Файлы</b>\n\nВ этом ответе файлы не создавались."
    lines = [f"{SYM['file']} <b>Файлы этого ответа:</b>\n"]
    for i, f in enumerate(files, 1):
        lines.append(f"  <b>{i}.</b> {SYM['tool']} <code>{TextFormatter.esc(f['tool'])}</code>: {TextFormatter.esc(f['name'])}")
    lines.append(f"\n{SYM['pointer']} Нажмите на номер, чтобы открыть файл")
    return "\n".join(lines)

@router.callback_query(F.data.startswith("files:"))
async def callback_files(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    files = data.get("files") or []
    text = _files_list_text(files)
    await safe_edit(callback, text, reply_markup=_files_list_keyboard(request_id, files))
    await callback.answer()

@router.callback_query(F.data.startswith("file_open:"))
async def callback_file_open(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id, idx_str = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    files = data.get("files") or []
    try:
        idx = int(idx_str)
        f = files[idx]
    except (ValueError, IndexError):
        await callback.answer("Файл не найден", show_alert=True)
        return

    fpath = Path(f["filepath"])
    back_markup = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"{SYM['back']} Назад к списку", callback_data=f"files:{request_id}")],
    ])

    if not fpath.exists():
        await safe_edit(
            callback,
            f"{SYM['error']} <b>Файл {idx + 1}: {TextFormatter.esc(f['name'])}</b>\n\n"
            f"Файл не найден на диске (возможно, был удалён после рестарта бота).",
            reply_markup=back_markup,
        )
        await callback.answer()
        return

    size = fpath.stat().st_size
    ext = fpath.suffix.lower()

    # ── Инлайн-превью содержимого ─────────────────────────────────
    # Текстовые/код-файлы показываем прямо в сообщении — без похода на
    # файлообменник вообще, это и быстрее, и не тратит внешний сервис
    # на то, что можно просто прочитать с диска.
    TEXT_PREVIEW_EXTENSIONS = {
        ".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml",
        ".html", ".css", ".xml", ".csv", ".log", ".ini", ".cfg", ".toml",
        ".sh", ".java", ".c", ".cpp", ".h", ".go", ".rs", ".sql", ".env",
    }
    IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
    PREVIEW_CHAR_LIMIT = 1500

    if ext in TEXT_PREVIEW_EXTENSIONS:
        try:
            raw_text = fpath.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            raw_text = f"[не удалось прочитать файл: {e}]"
        truncated = len(raw_text) > PREVIEW_CHAR_LIMIT
        preview = raw_text[:PREVIEW_CHAR_LIMIT]
        preview_block = (
            f"<pre>{TextFormatter.esc(preview)}</pre>"
            + (f"\n<i>… обрезано, всего {len(raw_text)} символов, полный файл — кнопкой ниже</i>" if truncated else "")
        )
        info_text = (
            f"{SYM['file']} <b>Файл {idx + 1}: {TextFormatter.esc(f['name'])}</b>\n"
            f"Инструмент: <code>{TextFormatter.esc(f['tool'])}</code> · Размер: <code>{size} bytes</code>\n\n"
            f"{preview_block}"
        )
        preview_markup = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text=f"{SYM['link']} Загрузить и получить ссылку", callback_data=f"file_dl:{request_id}:{idx}")],
            [InlineKeyboardButton(text=f"{SYM['back']} Назад к списку", callback_data=f"files:{request_id}")],
        ])
        try:
            if callback.message:
                await callback.message.edit_text(info_text, reply_markup=preview_markup)
            elif callback.inline_message_id:
                await bot.edit_message_text(
                    inline_message_id=callback.inline_message_id,
                    text=info_text,
                    reply_markup=preview_markup,
                )
        except Exception as e:
            logger.error(f"Failed to show inline text preview: {e}")
        await callback.answer()
        return

    if ext in IMAGE_EXTENSIONS and callback.message:
        # Растровые картинки шлём прямо как фото — реальное визуальное превью,
        # без похода на внешний файлообменник.
        try:
            await callback.message.answer_photo(
                FSInputFile(str(fpath)),
                caption=f"{SYM['file']} {TextFormatter.esc(f['name'])} · <code>{size} bytes</code>",
            )
            await callback.answer()
            return
        except Exception as e:
            logger.error(f"Failed to send inline photo preview: {e}")
            # падаем дальше на общий путь с файлообменником

    if ext == ".svg" and callback.message:
        # SVG Telegram как фото не рендерит, но большинство клиентов (Desktop/
        # Web/многие мобильные) сами показывают превью SVG при отправке как
        # документ — так что шлём документом прямо в чат, без файлообменника.
        try:
            await callback.message.answer_document(
                FSInputFile(str(fpath)),
                caption=f"{SYM['file']} {TextFormatter.esc(f['name'])} · <code>{size} bytes</code>",
            )
            await callback.answer()
            return
        except Exception as e:
            logger.error(f"Failed to send inline SVG preview: {e}")

    await safe_edit(
        callback,
        f"{SYM['pending']} <b>Файл {idx + 1}: {TextFormatter.esc(f['name'])}</b>\n\n"
        f"Загружаю на файлообменник...",
        reply_markup=back_markup,
    )
    await callback.answer()

    url = await upload_to_file_host(fpath)
    if url:
        info_text = (
            f"{SYM['file']} <b>Файл {idx + 1}: {TextFormatter.esc(f['name'])}</b>\n\n"
            f"Инструмент: <code>{TextFormatter.esc(f['tool'])}</code>\n"
            f"Размер: <code>{size} bytes</code>\n\n"
            f"{SYM['link']} <a href=\"{url}\">Скачать файл</a>"
        )
    else:
        info_text = (
            f"{SYM['error']} <b>Файл {idx + 1}: {TextFormatter.esc(f['name'])}</b>\n\n"
            f"Не удалось загрузить файл на файлообменник (все сервисы недоступны).\n"
            f"Попробуйте ещё раз позже."
        )
    try:
        if callback.message:
            await callback.message.edit_text(info_text, reply_markup=back_markup)
        elif callback.inline_message_id:
            await bot.edit_message_text(
                inline_message_id=callback.inline_message_id,
                text=info_text,
                reply_markup=back_markup,
            )
    except Exception as e:
        logger.error(f"Failed to edit message with upload result: {e}")

@router.callback_query(F.data.startswith("file_dl:"))
async def callback_file_download(callback: CallbackQuery):
    """Явная загрузка на файлообменник по кнопке из текстового превью —
    отдельный шаг, чтобы не грузить наружу файлы, которые и так уже
    полностью показаны инлайн."""
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id, idx_str = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    files = data.get("files") or []
    try:
        idx = int(idx_str)
        f = files[idx]
    except (ValueError, IndexError):
        await callback.answer("Файл не найден", show_alert=True)
        return

    fpath = Path(f["filepath"])
    back_markup = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"{SYM['back']} Назад к списку", callback_data=f"files:{request_id}")],
    ])
    if not fpath.exists():
        await callback.answer("Файл не найден на диске", show_alert=True)
        return

    await callback.answer("Загружаю...")
    size = fpath.stat().st_size
    url = await upload_to_file_host(fpath)
    if url:
        info_text = (
            f"{SYM['file']} <b>{TextFormatter.esc(f['name'])}</b>\n\n"
            f"Размер: <code>{size} bytes</code>\n\n"
            f"{SYM['link']} <a href=\"{url}\">Скачать файл</a>"
        )
    else:
        info_text = (
            f"{SYM['error']} <b>{TextFormatter.esc(f['name'])}</b>\n\n"
            f"Не удалось загрузить файл на файлообменник (все сервисы недоступны)."
        )
    try:
        if callback.message:
            await callback.message.edit_text(info_text, reply_markup=back_markup)
    except Exception as e:
        logger.error(f"Failed to edit message with download result: {e}")

@router.callback_query(F.data.startswith("backresult:"))
async def callback_back_to_result(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    data = _response_cache.get(request_id)
    if not await guard_callback_owner(callback, data):
        return

    page_text = data.get("page_text")
    markup = data.get("markup")
    if not page_text:
        await callback.answer("Не удалось восстановить ответ", show_alert=True)
        return
    await safe_edit(callback, page_text, reply_markup=markup)
    await callback.answer()


# ═══════════════════════════════════════════════════════════════════
# CALLBACK HANDLERS — скиллы и параметры
# ═══════════════════════════════════════════════════════════════════

async def _render_skills_menu(callback: CallbackQuery, prompt_id: str, data: dict) -> None:
    session = state.get_session(data["user_id"])
    active_skills = data.get("active_skills", list(session.active_skills))
    text = (
        f"{SYM['skill']} <b>Выбор скиллов</b>\n\n"
        f"Активные скиллы влияют на стиль ответа.\n"
        f"Нажмите для активации/деактивации:"
    )
    await safe_edit(callback, text, reply_markup=KeyboardBuilder.skills_menu(prompt_id, active_skills))
    await callback.answer()

@router.callback_query(F.data.startswith("skills_select:"))
async def callback_skills_select(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return
    await _render_skills_menu(callback, prompt_id, data)

@router.callback_query(F.data.startswith("toggle_skill:"))
async def callback_toggle_skill(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id, skill_name = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    user_id = callback.from_user.id
    active_skills = data.get("active_skills", [])
    if skill_name in active_skills:
        active_skills.remove(skill_name)
    else:
        active_skills.append(skill_name)
    data["active_skills"] = active_skills
    state.save_pending_prompts()
    
    session = state.get_session(user_id)
    session.active_skills = list(active_skills)
    
    await _render_skills_menu(callback, prompt_id, data)

async def _render_params_menu(callback: CallbackQuery, prompt_id: str, data: dict) -> None:
    """Общий рендер меню параметров. Раньше callback_set_temp/tokens/topp
    после сохранения значения звали callback_params(callback) НАПРЯМУЮ --
    но callback.data на тот момент всё ещё был "set_temp:id:0.7", а не
    "params:id", так что parse_callback_data ломался и prompt_id
    расклеивался в мусор ("id:0.7"), из-за чего кнопка молча превращалась
    в "кнопка устарела". Теперь prompt_id и data передаются явно, и любой
    вызывающий колбэк зовёт этот хелпер напрямую вместо чужого хендлера."""
    params = data["params"]
    is_settings_only = data.get("query") == "(настройки сессии)"
    session = state.get_session(data["user_id"])
    text = (
        f"{SYM['settings']} <b>{'Настройки генерации' if is_settings_only else 'Параметры генерации'}</b>\n\n"
        f"{SYM['diamond']} Модель: <code>{TextFormatter.esc(session.model or provider_registry.get_active()['model'])}</code>\n"
        f"{SYM['speed']} Температура: <code>{params.temperature}</code>\n"
        f"{SYM['tokens']} Max Tokens: <code>{params.max_tokens}</code>\n"
        f"{SYM['decide']} Top-P: <code>{params.top_p}</code>\n"
        f"{SYM['tool']} Активные тулы: <code>{', '.join(data.get('active_tools', [])) or 'авто'}</code>\n\n"
        f"Выберите параметр:"
    )
    keyboard = KeyboardBuilder.settings_params_buttons(prompt_id) if is_settings_only else KeyboardBuilder.params_buttons(prompt_id)
    await safe_edit(callback, text, reply_markup=keyboard)
    await callback.answer()

@router.callback_query(F.data.startswith("params:"))
async def callback_params(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return
    await _render_params_menu(callback, prompt_id, data)

@router.callback_query(F.data.startswith("param_temp:"))
async def callback_param_temp(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    await safe_edit(callback,
        f"{SYM['settings']} <b>Выберите температуру</b>\n\n"
        f"Текущая: <code>{data['params'].temperature}</code>\n"
        f"Низкая = точнее, высокая = креативнее",
        reply_markup=KeyboardBuilder.temp_selector(prompt_id, data["params"].temperature),
    )
    await callback.answer()

@router.callback_query(F.data.startswith("param_tokens:"))
async def callback_param_tokens(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    await safe_edit(callback,
        f"{SYM['settings']} <b>Выберите Max Tokens</b>\n\n"
        f"Текущее: <code>{data['params'].max_tokens}</code>\n"
        f"Максимальное количество токенов в ответе",
        reply_markup=KeyboardBuilder.tokens_selector(prompt_id, data["params"].max_tokens),
    )
    await callback.answer()

@router.callback_query(F.data.startswith("param_topp:"))
async def callback_param_topp(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    await safe_edit(callback,
        f"{SYM['settings']} <b>Выберите Top-P</b>\n\n"
        f"Текущее: <code>{data['params'].top_p}</code>\n"
        f"Nucleus sampling параметр",
        reply_markup=KeyboardBuilder.topp_selector(prompt_id, data["params"].top_p),
    )
    await callback.answer()

async def _render_tools_menu(callback: CallbackQuery, prompt_id: str, data: dict) -> None:
    session = state.get_session(data["user_id"])
    active_tools = data.get("active_tools", list(session.preferred_tools))
    await safe_edit(callback,
        f"{SYM['tool']} <b>Активные тулы</b>\n\n"
        f"Выберите тулы для автоматического использования:",
        reply_markup=KeyboardBuilder.tools_selector(prompt_id, active_tools),
    )
    await callback.answer()

@router.callback_query(F.data.startswith("param_model:"))
async def callback_param_model(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    session = state.get_session(data["user_id"])
    current_model = session.model or provider_registry.get_active()["model"]
    await safe_edit(
        callback,
        f"{SYM['diamond']} <b>Выбор модели</b>\n\nТекущая: <code>{TextFormatter.esc(current_model)}</code>",
        reply_markup=KeyboardBuilder.model_selector(prompt_id, current_model),
    )
    await callback.answer()

@router.callback_query(F.data.startswith("set_model_p:"))
async def callback_set_model_p(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id, provider_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    p = provider_registry.get(provider_id)
    if not p:
        await callback.answer("Эта модель больше недоступна", show_alert=True)
        return
    session = state.get_session(data["user_id"])
    session.model = p["model"]
    await callback.answer(f"Модель: {p['model']}")
    await _render_params_menu(callback, prompt_id, data)

@router.callback_query(F.data.startswith("param_tools:"))
async def callback_param_tools(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return
    await _render_tools_menu(callback, prompt_id, data)

@router.callback_query(F.data.startswith("toggle_tool:"))
async def callback_toggle_tool(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id, tool_name = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    active_tools = data.get("active_tools", [])
    if tool_name in active_tools:
        active_tools.remove(tool_name)
    else:
        active_tools.append(tool_name)
    data["active_tools"] = active_tools
    state.save_pending_prompts()
    
    session = state.get_session(data["user_id"])
    session.preferred_tools = list(active_tools)
    
    await _render_tools_menu(callback, prompt_id, data)

@router.callback_query(F.data.startswith("set_temp:"))
async def callback_set_temp(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id, temp = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return
    try:
        temp = float(temp)
    except ValueError:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    data["params"].temperature = temp
    state.save_pending_prompts()
    session = state.get_session(data["user_id"])
    session.temperature = temp
    await _render_params_menu(callback, prompt_id, data)

@router.callback_query(F.data.startswith("set_tokens:"))
async def callback_set_tokens(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id, tokens = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return
    try:
        tokens = int(tokens)
    except ValueError:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    data["params"].max_tokens = tokens
    state.save_pending_prompts()
    session = state.get_session(data["user_id"])
    session.max_tokens = tokens
    await _render_params_menu(callback, prompt_id, data)

@router.callback_query(F.data.startswith("set_topp:"))
async def callback_set_topp(callback: CallbackQuery):
    parts = parse_callback_data(callback, 3)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id, topp = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return
    try:
        topp = float(topp)
    except ValueError:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    data["params"].top_p = topp
    state.save_pending_prompts()
    session = state.get_session(data["user_id"])
    session.top_p = topp
    await _render_params_menu(callback, prompt_id, data)

@router.callback_query(F.data.startswith("back_to_gen:"))
async def callback_back_to_gen(callback: CallbackQuery):
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, prompt_id = parts
    data = state.pending_prompts.get(prompt_id)
    if not await guard_callback_owner(callback, data):
        return

    query = data["query"]
    await safe_edit(callback,
        f"{TextFormatter.format_prompt_block(query)}\n\n"
        f"{SYM['typing']} Нажмите кнопку для запуска:",
        reply_markup=KeyboardBuilder.generate_button(prompt_id),
    )
    await callback.answer()


# ═══════════════════════════════════════════════════════════════════
# CALLBACK HANDLERS — панель владельца
# ═══════════════════════════════════════════════════════════════════

@router.callback_query(F.data == "stats")
async def callback_stats(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    stats_text = (
        f"{SYM['stats']} <b>Статистика XGO v2.0</b>\n\n"
        f"{SYM['circle']} Всего сессий: <code>{len(state.sessions)}</code>\n"
        f"{SYM['check']} Одобрено: <code>{len(state.approved_users)}</code>\n"
        f"{SYM['cross']} Заблокировано: <code>{len(state.blocked_users)}</code>\n"
        f"{SYM['pending']} В очереди: <code>{len(state.pending_requests)}</code>\n"
        f"{SYM['prompt']} Всего запросов: <code>{state.global_stats['total_requests']}</code>\n"
        f"{SYM['tokens']} Всего токенов: <code>{state.global_stats['total_tokens']}</code>\n"
        f"{SYM['tool']} Тулов использовано: <code>{state.global_stats['total_tools_used']}</code>\n"
        f"{SYM['brain']} Модель: <code>{provider_registry.get_active()['model']}</code>"
    )
    await safe_edit(callback, stats_text, reply_markup=KeyboardBuilder.owner_stats_menu())
    await callback.answer()

@router.callback_query(F.data == "users")
async def callback_users(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    if not state.approved_users:
        await safe_edit(callback,
            f"{SYM['users']} <b>Нет одобренных пользователей</b>",
            reply_markup=KeyboardBuilder.owner_stats_menu(),
        )
        await callback.answer()
        return
    
    users_list = list(state.approved_users)
    await safe_edit(callback,
        f"{SYM['users']} <b>Одобренные пользователи</b>\n\n"
        f"Всего: <code>{len(users_list)}</code>",
        reply_markup=KeyboardBuilder.owner_users_menu(users_list),
    )
    await callback.answer()

@router.callback_query(F.data.startswith("users_page:"))
async def callback_users_page(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    try:
        page = int(parts[1])
    except ValueError:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    users_list = list(state.approved_users)
    await safe_edit(callback,
        f"{SYM['users']} <b>Одобренные пользователи</b>\n\n"
        f"Страница {page+1} из {(len(users_list)//8)+1}",
        reply_markup=KeyboardBuilder.owner_users_menu(users_list, page),
    )
    await callback.answer()

@router.callback_query(F.data.startswith("user_block:"))
async def callback_user_block(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    try:
        uid = int(parts[1])
    except ValueError:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    state.block_user(uid)
    await callback.answer(f"Пользователь {uid} заблокирован")
    await callback_users(callback)

@router.callback_query(F.data == "toggle_notif")
async def callback_toggle_notif(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    state.owner_notifications = not state.owner_notifications
    status = "включены" if state.owner_notifications else "отключены"
    await callback.answer(f"Уведомления {status}")
    await safe_edit(callback,
        f"{SYM['check']} Уведомления {status}",
        reply_markup=KeyboardBuilder.owner_panel(),
    )

@router.callback_query(F.data == "queue")
async def callback_queue(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    if not state.pending_requests:
        await safe_edit(callback,
            f"{SYM['queue']} <b>Очередь пуста</b>",
            reply_markup=KeyboardBuilder.owner_panel(),
        )
        await callback.answer()
        return
    
    requests_list = list(state.pending_requests.values())
    await safe_edit(callback,
        f"{SYM['queue']} <b>Очередь запросов</b>\n\n"
        f"Всего: <code>{len(requests_list)}</code>",
        reply_markup=KeyboardBuilder.owner_queue_menu(requests_list),
    )
    await callback.answer()

@router.callback_query(F.data == "owner_skills")
async def callback_owner_skills(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    
    skills = state.skill_manager.list_skills()
    text = f"{SYM['skill']} <b>Доступные скиллы</b>\n\n"
    for skill in skills:
        status = SYM["check"] if skill.enabled else SYM["cross"]
        text += f"{status} {skill.icon} <b>{skill.name}</b> — {skill.description}\n"
    
    await safe_edit(callback, text, reply_markup=KeyboardBuilder.owner_panel())
    await callback.answer()

@router.callback_query(F.data == "owner_tools")
async def callback_owner_tools(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    
    tools = state.tool_manager.list_tools()
    text = f"{SYM['tool']} <b>Доступные тулы</b>\n\n"
    for tool in tools:
        text += f"{tool.icon} <b>{tool.name}</b> — {tool.description}\n"
    
    await safe_edit(callback, text, reply_markup=KeyboardBuilder.owner_panel())
    await callback.answer()

@router.callback_query(F.data == "owner_refresh")
async def callback_owner_refresh(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    await safe_edit(callback,
        TextFormatter.format_welcome(True),
        reply_markup=KeyboardBuilder.owner_panel(),
    )
    await callback.answer("Обновлено")

@router.callback_query(F.data == "owner_back")
async def callback_owner_back(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    await safe_edit(callback,
        TextFormatter.format_welcome(True),
        reply_markup=KeyboardBuilder.owner_panel(),
    )
    await callback.answer()

@router.callback_query(F.data.startswith("approve:"))
async def callback_approve(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    req = state.pop_pending_request(request_id)
    if not req:
        await callback.answer("Запрос не найден", show_alert=True)
        return
    state.approve_user(req.user_id)
    event_log.add("user", f"Юзер одобрен через Telegram: {req.user_id} (@{req.username or '?'})", {"user_id": req.user_id})
    try:
        await bot.send_message(
            req.user_id,
            f"{SYM['unlock']} <b>Доступ разрешён</b>\n\n"
            f"Владелец одобрил ваш запрос.\n"
            f"Теперь вы можете использовать <code>/ask</code>"
        )
    except Exception as e:
        logger.error(f"Failed to notify approved user: {e}")
    await safe_edit(callback,
        f"{TextFormatter.format_pending_request(req)}\n\n{SYM['check']} <b>Одобрено</b>")
    await callback.answer("Пользователь одобрен")

@router.callback_query(F.data.startswith("reject:"))
async def callback_reject(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    req = state.pop_pending_request(request_id)
    if not req:
        await callback.answer("Запрос не найден", show_alert=True)
        return
    try:
        await bot.send_message(
            req.user_id,
            f"{SYM['cross']} <b>Доступ отклонён</b>\n\n"
            f"Владелец отклонил ваш запрос."
        )
    except Exception as e:
        logger.error(f"Failed to notify rejected user: {e}")
    await safe_edit(callback,
        f"{TextFormatter.format_pending_request(req)}\n\n{SYM['cross']} <b>Отклонено</b>")
    await callback.answer("Пользователь отклонён")

@router.callback_query(F.data.startswith("block:"))
async def callback_block(callback: CallbackQuery):
    if callback.from_user.id != OWNER_ID:
        await callback.answer("Только для владельца!", show_alert=True)
        return
    parts = parse_callback_data(callback, 2)
    if not parts:
        await callback.answer("Ошибка кнопки, попробуйте снова", show_alert=True)
        return
    _, request_id = parts
    req = state.pop_pending_request(request_id)
    if not req:
        await callback.answer("Запрос не найден", show_alert=True)
        return
    state.block_user(req.user_id)
    event_log.add("user", f"Юзер заблокирован через Telegram: {req.user_id} (@{req.username or '?'})", {"user_id": req.user_id})
    try:
        await bot.send_message(
            req.user_id,
            f"{SYM['cross']} <b>Вы заблокированы</b>\n\n"
            f"Владелец добавил вас в чёрный список."
        )
    except Exception as e:
        logger.error(f"Failed to notify blocked user: {e}")
    await safe_edit(callback,
        f"{TextFormatter.format_pending_request(req)}\n\n{SYM['lock']} <b>Заблокировано</b>")
    await callback.answer("Пользователь заблокирован")


# ═══════════════════════════════════════════════════════════════════
# INLINE MODE
# ═══════════════════════════════════════════════════════════════════

@router.inline_query()
async def inline_query_handler(query: InlineQuery):
    user_id = query.from_user.id
    if not state.is_approved(user_id):
        results = [
            InlineQueryResultArticle(
                id="no_access",
                title=f"{SYM['lock']} Доступ ограничен",
                description="Напишите боту /start в личные сообщения.",
                input_message_content=InputTextMessageContent(
                    message_text=f"{SYM['lock']} <b>Доступ ограничен</b>\n\nНапишите боту в личные сообщения /start, чтобы запросить доступ.",
                    parse_mode=ParseMode.HTML,
                ),
            )
        ]
        await query.answer(results, cache_time=1, is_personal=True)
        return

    search_text = query.query.strip()
    if not search_text:
        results = [
            InlineQueryResultArticle(
                id="help",
                title=f"{SYM['sparkle']} XGO AI — начните вводить вопрос",
                description="Например: @botname объясни рекурсию",
                input_message_content=InputTextMessageContent(
                    message_text=f"{SYM['bot']} <b>XGO v2.0</b>\n\nВведите вопрос после имени бота, например:\n<code>@botname объясни рекурсию</code>",
                    parse_mode=ParseMode.HTML,
                ),
            )
        ]
        await query.answer(results, cache_time=1, is_personal=True)
        return

    # Раньше инлайн-режим вообще не знал про систему модов и всегда
    # трактовал текст как промпт для основного ассистента -- поэтому
    # "@botname clawback ..." не запускал мод. Если первое слово совпадает
    # с зарегистрированным mod_id, отдаём результат, который при выборе
    # вставляется в чат как обычное сообщение "/<mod_id> <остальное>" --
    # его дальше ловит тот же cmd_mod_dynamic, что и в обычном чате, так
    # что логика не дублируется.
    first_word, _, rest = search_text.lstrip("/").partition(" ")
    mod_conn = mod_registry.get(first_word)
    if mod_conn and mod_conn.enabled:
        sent_text = f"/{first_word} {rest.strip()}".rstrip()
        results = [
            InlineQueryResultArticle(
                id=f"mod_{first_word}",
                title=f"{SYM['tool']} Спросить {mod_conn.title}: {rest.strip()[:60] or '...'}",
                description="Нажмите, чтобы отправить запрос модулю",
                input_message_content=InputTextMessageContent(message_text=sent_text),
            )
        ]
        await query.answer(results, cache_time=1, is_personal=True)
        return

    session = state.get_session(user_id)
    prompt_id = str(uuid.uuid4())[:12]
    state.pending_prompts[prompt_id] = {
        "user_id": user_id,
        "query": search_text,
        "chat_id": None,
        "created_at": time.time(),
        "params": GenerationParams(
            max_tokens=session.max_tokens,
            temperature=session.temperature,
            top_p=session.top_p,
        ),
        "active_skills": list(session.active_skills),
        "active_tools": list(session.preferred_tools),
    }
    state.save_pending_prompts()

    confirm_text = (
        f"{TextFormatter.format_prompt_block(search_text)}\n\n"
        f"{SYM['typing']} Нажмите кнопку для запуска:"
    )
    results = [
        InlineQueryResultArticle(
            id=prompt_id,
            title=f"{SYM['sparkle']} Спросить XGO: {search_text[:60]}",
            description="Нажмите, затем в чате нажмите «Сгенерировать»",
            input_message_content=InputTextMessageContent(
                message_text=confirm_text,
                parse_mode=ParseMode.HTML,
            ),
            reply_markup=KeyboardBuilder.generate_button(prompt_id),
        )
    ]
    await query.answer(results, cache_time=1, is_personal=True)


# ═══════════════════════════════════════════════════════════════════
# FILE HANDLING — приём файлов по реплаю и напрямую
# ═══════════════════════════════════════════════════════════════════

def _has_pending_github_setup(message: Message) -> bool:
    if not message.text or message.text.startswith("/"):
        return False
    session = state.sessions.get(message.from_user.id)
    return bool(session and session.github_setup)

@router.message(F.func(_has_pending_github_setup))
async def handle_github_setup_input(message: Message):
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        return
    session = state.get_session(user_id)
    setup = session.github_setup
    if not setup:
        return
    step = setup.get("step")
    text = message.text.strip()
    cancel_markup = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"{SYM['cross']} Отмена", callback_data="gh_cancel_setup")],
    ])

    if step == "token_repo":
        parts = text.split()
        if len(parts) != 2 or "/" not in parts[1] or parts[1].count("/") != 1:
            await message.answer(
                f"{SYM['error']} Неверный формат. Нужно: <code>токен owner/repo</code>\n"
                f"Например: <code>ghp_abc123 torvalds/linux</code>",
                reply_markup=cancel_markup,
            )
            return
        token, repo_part = parts
        owner, repo = (p.strip() for p in repo_part.split("/"))
        if not owner or not repo:
            await message.answer(f"{SYM['error']} Неверный формат repo. Нужно <code>owner/repo</code>", reply_markup=cancel_markup)
            return

        setup["token"] = token
        setup["owner"] = owner
        setup["repo"] = repo
        setup["step"] = "branch"
        session.github_setup = setup

        # Удаляем сообщение с токеном сразу — не оставляем секрет в истории чата.
        try:
            await message.delete()
        except Exception:
            pass

        await message.answer(
            f"{SYM['tool']} <b>Подключение GitHub — шаг 2/2</b>\n\n"
            f"{SYM['check']} Токен получен (сообщение удалено).\n"
            f"Репозиторий: <code>{TextFormatter.esc(owner)}/{TextFormatter.esc(repo)}</code>\n\n"
            f"Выберите ветку:",
            reply_markup=_branch_selector_keyboard(),
        )
        return

    if step == "branch_custom":
        if not text:
            await message.answer(f"{SYM['error']} Название ветки не может быть пустым", reply_markup=cancel_markup)
            return
        await _finalize_github_connection(message, user_id, session, setup, text)
        return


def _fmt_media_size(num_bytes: Optional[int]) -> str:
    """Человекочитаемый размер файла для галереи в панели."""
    if not num_bytes:
        return ""
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


async def _download_incoming_media(kind: str, file_id: str, suggested_name: str = "") -> Optional[dict]:
    """Качает фото/видео/документ, присланные юзером боту, в MEDIA_DIR и
    возвращает описание для чат-истории/галереи панели: {type, url, name, size}.
    Имя файла на диске всегда рандомное (uuid), чтобы не пересекалось с
    другими юзерами и не палило оригинальные имена в URL. При любой ошибке
    скачивания возвращает None -- сообщение всё равно попадёт в чат-историю
    текстом, просто без медиа-вложения."""
    try:
        file = await bot.get_file(file_id)
        ext = Path(file.file_path or "").suffix or {"photo": ".jpg", "video": ".mp4"}.get(kind, "")
        disk_name = f"{uuid.uuid4().hex}{ext}"
        dest = MEDIA_DIR / disk_name
        await bot.download_file(file.file_path, dest)
        size_bytes = dest.stat().st_size if dest.exists() else None
        return {
            "type": kind,
            "url": f"/media/{disk_name}",
            "name": suggested_name or disk_name,
            "size": _fmt_media_size(size_bytes),
        }
    except Exception as e:
        logger.error(f"Не удалось скачать входящее медиа ({kind}, file_id={file_id}): {e}")
        return None


@router.message(F.reply_to_message)
async def handle_reply(message: Message):
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        return

    replied = message.reply_to_message
    reply_to_text = (replied.text or replied.caption or "") if replied else ""
    display_name = ("@" + message.from_user.username) if message.from_user.username else (message.from_user.first_name or "")

    session = state.get_session(user_id)
    if session.awaiting_ask_user and message.text and not message.text.startswith("/"):
        # Ответ на ForceReply-приглашение после кнопки «Свой ответ» на
        # вопросе ask_user -- дописываем ответ и, если это был последний
        # неотвеченный вопрос паузы, продолжаем агента.
        pause_id, q_idx = session.awaiting_ask_user
        session.awaiting_ask_user = None
        answer_text = message.text.strip()
        try:
            await message.answer(f"{SYM['check']} Ответ принят: {TextFormatter.esc(answer_text[:200])}")
        except Exception:
            pass
        ready = await _record_ask_user_answer(pause_id, q_idx, answer_text)
        if ready:
            await _resume_paused_agent(pause_id, ready)
        return

    if session.awaiting_input and message.text and not message.text.startswith("/"):
        # Ответ на ForceReply-приглашение после кнопки «Продолжить» --
        # уходит как /ask с подмешанным контекстом продолжаемого диалога,
        # не в чат-лог.
        session.awaiting_input = False
        continue_request_id = session.awaiting_continue_request_id
        session.awaiting_continue_request_id = None
        await _create_ask_prompt(message, user_id, message.text.strip(), continue_request_id=continue_request_id)
        return

    if message.document:
        doc = message.document
        media = await _download_incoming_media("document", doc.file_id, doc.file_name or "")
        chat_store.add(
            user_id, "in", f"[файл] {doc.file_name}",
            message_id=message.message_id,
            reply_to_message_id=replied.message_id if replied else None,
            reply_to_text=reply_to_text,
            display_name=display_name,
            media=media,
        )
        try:
            file = await bot.get_file(doc.file_id)
            dest = FILES_DIR / (doc.file_name or f"file_{uuid.uuid4().hex[:8]}")
            await bot.download_file(file.file_path, dest)
            await message.answer(
                f"{SYM['file']} <b>Файл получен</b>\n\n"
                f"Имя: <code>{doc.file_name}</code>\n"
                f"Размер: <code>{doc.file_size} bytes</code>\n"
                f"Сохранён: <code>{dest.name}</code>"
            )
        except Exception as e:
            await message.answer(f"{SYM['error']} Ошибка загрузки: <code>{TextFormatter.esc(str(e))}</code>")
    elif message.photo:
        photo = message.photo[-1]  # самое большое разрешение
        media = await _download_incoming_media("photo", photo.file_id)
        chat_store.add(
            user_id, "in", message.caption or "[фото]",
            message_id=message.message_id,
            reply_to_message_id=replied.message_id if replied else None,
            reply_to_text=reply_to_text,
            display_name=display_name,
            media=media,
        )
        event_log.add("chat_in", f"Юзер {user_id} прислал фото в чат", {"user_id": user_id})
    elif message.video:
        media = await _download_incoming_media("video", message.video.file_id, message.video.file_name or "")
        chat_store.add(
            user_id, "in", message.caption or "[видео]",
            message_id=message.message_id,
            reply_to_message_id=replied.message_id if replied else None,
            reply_to_text=reply_to_text,
            display_name=display_name,
            media=media,
        )
        event_log.add("chat_in", f"Юзер {user_id} прислал видео в чат", {"user_id": user_id})
    elif message.text and not message.text.startswith("/"):
        chat_store.add(
            user_id, "in", message.text,
            message_id=message.message_id,
            reply_to_message_id=replied.message_id if replied else None,
            reply_to_text=reply_to_text,
            display_name=display_name,
        )
        event_log.add("chat_in", f"Юзер {user_id} ответил в чате: {message.text[:120]}", {"user_id": user_id})


@router.message(F.text & ~F.text.startswith("/"))
async def handle_plain_chat_message(message: Message):
    """Ловит ЛЮБОЕ обычное текстовое сообщение юзера боту (не команду, не
    ответ -- тот уже поймал handle_reply выше), чтобы вся переписка была
    видна в мини-чате панели, а не только явные /ask и ответы на сообщения
    бота. Ничего не отвечает юзеру сам по себе -- просто фиксирует сообщение;
    отвечать можно через /ask или прямо из панели."""
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        return
    display_name = ("@" + message.from_user.username) if message.from_user.username else (message.from_user.first_name or "")
    chat_store.add(user_id, "in", message.text, message_id=message.message_id, display_name=display_name)
    event_log.add("chat_in", f"Юзер {user_id} написал в чат: {message.text[:120]}", {"user_id": user_id})


@router.message(F.document)
async def handle_document(message: Message):
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        return

    doc = message.document
    display_name = ("@" + message.from_user.username) if message.from_user.username else (message.from_user.first_name or "")
    media = await _download_incoming_media("document", doc.file_id, doc.file_name or "")
    chat_store.add(user_id, "in", f"[файл] {doc.file_name}", message_id=message.message_id, display_name=display_name, media=media)
    event_log.add("chat_in", f"Юзер {user_id} прислал файл в чат: {doc.file_name}", {"user_id": user_id})
    try:
        file = await bot.get_file(doc.file_id)
        dest = FILES_DIR / (doc.file_name or f"file_{uuid.uuid4().hex[:8]}")
        await bot.download_file(file.file_path, dest)
        await message.answer(
            f"{SYM['file']} <b>Файл получен</b>\n\n"
            f"Имя: <code>{doc.file_name}</code>\n"
            f"Размер: <code>{doc.file_size} bytes</code>\n"
            f"Сохранён: <code>{dest.name}</code>\n\n"
            f"Отправьте <code>/ask проанализируй файл {doc.file_name}</code> для обработки"
        )
    except Exception as e:
        await message.answer(f"{SYM['error']} Ошибка: <code>{TextFormatter.esc(str(e))}</code>")


@router.message(F.photo)
async def handle_photo(message: Message):
    """Обычное (не-reply) фото от юзера -- фиксируем в чат-истории и
    галерее панели, ничего в ответ не пишем (аналогично обычным текстам,
    см. handle_plain_chat_message)."""
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        return
    display_name = ("@" + message.from_user.username) if message.from_user.username else (message.from_user.first_name or "")
    photo = message.photo[-1]
    media = await _download_incoming_media("photo", photo.file_id)
    chat_store.add(user_id, "in", message.caption or "[фото]", message_id=message.message_id, display_name=display_name, media=media)
    event_log.add("chat_in", f"Юзер {user_id} прислал фото в чат", {"user_id": user_id})


@router.message(F.video)
async def handle_video(message: Message):
    """Обычное (не-reply) видео от юзера -- аналогично handle_photo."""
    user_id = message.from_user.id
    if not state.is_approved(user_id):
        return
    display_name = ("@" + message.from_user.username) if message.from_user.username else (message.from_user.first_name or "")
    media = await _download_incoming_media("video", message.video.file_id, message.video.file_name or "")
    chat_store.add(user_id, "in", message.caption or "[видео]", message_id=message.message_id, display_name=display_name, media=media)
    event_log.add("chat_in", f"Юзер {user_id} прислал видео в чат", {"user_id": user_id})


# ═══════════════════════════════════════════════════════════════════
# MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════

async def main():
    logger.info(f"Starting XGO Bot v2.0 with model: {provider_registry.get_active()['model']}")
    await sync_bot_commands()
    asyncio.create_task(_cleanup_expired_caches())
    asyncio.create_task(_run_mod_hook_server())
    asyncio.create_task(_run_panel_server())
    retry_delay = 5
    max_retry_delay = 60
    while True:
        try:
            await dp.start_polling(bot)
            break  # start_polling завершился штатно (например, по сигналу) — выходим
        except Exception as e:
            logger.error(f"Polling crashed: {e}. Restarting in {retry_delay}s...", exc_info=True)
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, max_retry_delay)

if __name__ == "__main__":
    asyncio.run(main())

