"""模型网关契约：检查发出去的请求，以及不能当作建议的回复。"""

import json
from types import SimpleNamespace

import httpx
import pytest

from acp.agent import llm
from acp.config import Settings


def model_gateway(monkeypatch, effort, respond):
    settings = Settings(
        llm_enabled=True, llm_base_url="http://agentgateway:3001/v1",
        llm_model="example-sol", llm_reasoning_effort=effort, llm_api_key="",
    )
    monkeypatch.setattr(llm, "get_settings", lambda: settings)
    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(llm, "httpx", SimpleNamespace(
        AsyncClient=lambda **kwargs: httpx.AsyncClient(transport=transport, **kwargs),
        Timeout=httpx.Timeout, HTTPError=httpx.HTTPError,
    ))


@pytest.mark.parametrize("effort", ["xhigh", ""])
async def test_chat_gateway_contract(monkeypatch, effort):
    def respond(req):
        assert str(req.url) == "http://agentgateway:3001/v1/chat/completions"
        assert "authorization" not in req.headers
        payload = json.loads(req.content)
        assert payload["model"] == "example-sol"
        assert [m["content"] for m in payload["messages"]] == ["规则", "进度"]
        if effort:
            assert payload["reasoning_effort"] == effort and payload["max_completion_tokens"] > 600
            assert "max_tokens" not in payload and "temperature" not in payload
        else:
            assert payload["max_tokens"] == 600 and payload["temperature"] == 0.2
            assert "reasoning_effort" not in payload and "max_completion_tokens" not in payload
        return httpx.Response(200, json={"choices": [{"message": {"content": "等待审核"}, "finish_reason": "stop"}]})

    model_gateway(monkeypatch, effort, respond)
    assert await llm.chat("规则", "进度", max_tokens=600) == "等待审核"


@pytest.mark.parametrize("response", [
    {"choices": [{"message": {"content": '{"op":"offer"}'}, "finish_reason": "length"}]},
    {"choices": []},
])
async def test_incomplete_suggestion_falls_back_to_rules(monkeypatch, response):
    model_gateway(monkeypatch, "xhigh", lambda _: httpx.Response(200, json=response))
    assert await llm.chat_json("只提建议", "整理需求") is None
