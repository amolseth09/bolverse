"""Instruction-tuned LLM (default Qwen2.5-7B-Instruct) for lessons, tutor answers
and, optionally, translation."""
from __future__ import annotations

import json
import re

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from ..config import settings
from ..runtime import DEVICE, DTYPE, Lazy


class LLMError(RuntimeError):
    pass


def _load():
    # Load straight onto the GPU in pieces instead of building a full copy in RAM first:
    # Colab's free machine has ~12 GB of RAM, and the full copy was enough to get the server killed.
    kwargs: dict = {"torch_dtype": DTYPE, "low_cpu_mem_usage": True}
    if DEVICE == "cuda" and not settings.llm_4bit:
        kwargs["device_map"] = "cuda"
    if settings.llm_4bit:
        from transformers import BitsAndBytesConfig

        kwargs["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16)
        kwargs["device_map"] = "auto"
    tok = AutoTokenizer.from_pretrained(settings.llm_model)
    model = AutoModelForCausalLM.from_pretrained(settings.llm_model, **kwargs)
    if "device_map" not in kwargs:
        model.to(DEVICE)
    model.eval()
    return tok, model


LLM = Lazy("language model", _load)


def chat(messages: list[dict[str, str]], max_new_tokens: int = 900, temperature: float = 0.4) -> str:
    tok, model = LLM.get()
    prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tok(prompt, return_tensors="pt").to(model.device)
    gen = {"max_new_tokens": max_new_tokens, "pad_token_id": tok.eos_token_id}
    if temperature > 0:
        gen.update(do_sample=True, temperature=temperature, top_p=0.9)
    else:
        gen.update(do_sample=False)
    with LLM.run_lock, torch.inference_mode():
        out = model.generate(**inputs, **gen)
    return tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object found")
    return json.loads(text[start:end + 1])


def chat_json(messages: list[dict[str, str]], **kwargs) -> dict:
    convo = list(messages)
    for _ in range(2):
        reply = chat(convo, **kwargs)
        try:
            return extract_json(reply)
        except ValueError:
            convo += [
                {"role": "assistant", "content": reply},
                {"role": "user", "content": "That was not valid JSON. Reply again with only the JSON object, nothing else."},
            ]
    raise LLMError("The language model didn't return valid JSON. Try again.")
