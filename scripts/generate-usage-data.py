#!/usr/bin/env python3
"""
Generate realistic large-scale LLM usage data for 30 users across 5 departments.
Writes directly to DynamoDB cc-on-bedrock-usage table.

Models: Opus 4.6, Sonnet 4.6, Haiku 4.5, Sonnet 4.5, Opus 4.5
Departments: engineering(8), data-science(6), product(6), devops(5), research(5)
Period: last 30 days
"""
import os
import boto3
import random
import math
from datetime import datetime, timedelta
from decimal import Decimal

REGION = os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-2")
TABLE_NAME = "cc-on-bedrock-usage"
NUM_DAYS = 30

dynamodb = boto3.resource("dynamodb", region_name=REGION)
table = dynamodb.Table(TABLE_NAME)

# ─── Models & Pricing (per 1M tokens) ───
MODELS = {
    "claude-opus-4-6-v1": {"input": 15.0, "output": 75.0, "avg_latency": 8000},
    "claude-sonnet-4-6-v1": {"input": 3.0, "output": 15.0, "avg_latency": 3500},
    "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.0, "avg_latency": 800},
    "claude-sonnet-4-5-20250514": {"input": 3.0, "output": 15.0, "avg_latency": 3000},
    "claude-opus-4-5-20250514": {"input": 15.0, "output": 75.0, "avg_latency": 9000},
}

# ─── Department Configuration ───
# model_weights: probability distribution for model selection
# intensity: avg requests per user per day
# token_scale: multiplier for token counts
DEPARTMENTS = {
    "engineering": {
        "count": 8,
        "model_weights": {
            "claude-sonnet-4-6-v1": 0.45,
            "claude-haiku-4-5-20251001": 0.25,
            "claude-opus-4-6-v1": 0.15,
            "claude-sonnet-4-5-20250514": 0.10,
            "claude-opus-4-5-20250514": 0.05,
        },
        "intensity": (30, 80),       # requests/day range
        "token_scale": (1.0, 2.5),   # multiplier for tokens
        "use_cases": "code generation, debugging, refactoring, code review",
    },
    "data-science": {
        "count": 6,
        "model_weights": {
            "claude-opus-4-6-v1": 0.30,
            "claude-sonnet-4-6-v1": 0.30,
            "claude-opus-4-5-20250514": 0.15,
            "claude-sonnet-4-5-20250514": 0.15,
            "claude-haiku-4-5-20251001": 0.10,
        },
        "intensity": (40, 100),
        "token_scale": (1.5, 3.5),
        "use_cases": "data analysis, ML pipeline, research papers",
    },
    "product": {
        "count": 6,
        "model_weights": {
            "claude-sonnet-4-6-v1": 0.40,
            "claude-haiku-4-5-20251001": 0.35,
            "claude-sonnet-4-5-20250514": 0.15,
            "claude-opus-4-6-v1": 0.07,
            "claude-opus-4-5-20250514": 0.03,
        },
        "intensity": (15, 45),
        "token_scale": (0.5, 1.5),
        "use_cases": "specs, user stories, documentation",
    },
    "devops": {
        "count": 5,
        "model_weights": {
            "claude-sonnet-4-6-v1": 0.40,
            "claude-haiku-4-5-20251001": 0.30,
            "claude-sonnet-4-5-20250514": 0.15,
            "claude-opus-4-6-v1": 0.10,
            "claude-opus-4-5-20250514": 0.05,
        },
        "intensity": (20, 60),
        "token_scale": (0.8, 2.0),
        "use_cases": "IaC, CI/CD, troubleshooting, monitoring",
    },
    "research": {
        "count": 5,
        "model_weights": {
            "claude-opus-4-6-v1": 0.35,
            "claude-opus-4-5-20250514": 0.20,
            "claude-sonnet-4-6-v1": 0.25,
            "claude-sonnet-4-5-20250514": 0.10,
            "claude-haiku-4-5-20251001": 0.10,
        },
        "intensity": (50, 120),
        "token_scale": (2.0, 5.0),
        "use_cases": "long context analysis, paper writing, brainstorming",
    },
}


def weighted_choice(weights: dict) -> str:
    """Pick a model based on probability weights."""
    models = list(weights.keys())
    probs = list(weights.values())
    return random.choices(models, weights=probs, k=1)[0]


def gen_token_counts(model: str, scale: float) -> tuple:
    """Generate realistic input/output token counts."""
    # Base token ranges by use pattern
    if "opus" in model:
        # Opus: long complex prompts, long outputs
        inp = random.randint(2000, 25000)
        out = random.randint(1000, 15000)
    elif "haiku" in model:
        # Haiku: short quick queries
        inp = random.randint(100, 3000)
        out = random.randint(50, 1500)
    else:
        # Sonnet: medium-length coding tasks
        inp = random.randint(500, 12000)
        out = random.randint(300, 8000)

    inp = int(inp * scale)
    out = int(out * scale)
    return inp, out


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    pricing = MODELS[model]
    return (input_tokens * pricing["input"] + output_tokens * pricing["output"]) / 1_000_000


def gen_latency(model: str, output_tokens: int) -> int:
    """Realistic latency: base + output-proportional."""
    base = MODELS[model]["avg_latency"]
    # ~10-20ms per output token + base with noise
    per_token = random.uniform(8, 25) if "opus" in model else random.uniform(5, 15)
    latency = base + int(output_tokens * per_token * 0.01)
    return int(latency * random.uniform(0.6, 1.8))


def weekend_factor(date: datetime) -> float:
    """Weekends have less activity."""
    if date.weekday() >= 5:
        return random.uniform(0.1, 0.4)
    return 1.0


def user_activity_pattern(user_idx: int, day_idx: int) -> float:
    """Each user has a unique activity pattern — some peak early, some late."""
    # Sinusoidal pattern with per-user phase offset
    phase = (user_idx * 37) % 30  # unique phase per user
    return 0.5 + 0.5 * math.sin(2 * math.pi * (day_idx + phase) / 14)


def generate_data():
    today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    dates = [(today - timedelta(days=d)).strftime("%Y-%m-%d") for d in range(NUM_DAYS - 1, -1, -1)]

    # Build user list
    users = []
    user_num = 1
    for dept, cfg in DEPARTMENTS.items():
        for i in range(cfg["count"]):
            padded = f"{user_num:02d}"
            users.append({
                "username": f"{dept}-{padded}",
                "department": dept,
                "intensity": cfg["intensity"],
                "token_scale": cfg["token_scale"],
                "model_weights": cfg["model_weights"],
                "idx": user_num,
            })
            user_num += 1

    print(f"Generating usage data for {len(users)} users x {NUM_DAYS} days x multiple models")
    dept_info = ", ".join(f"{d}({c['count']})" for d, c in DEPARTMENTS.items())
    print(f"Departments: {dept_info}")
    print()

    total_records = 0
    total_requests = 0
    total_cost = 0.0
    dept_aggregates = {}  # (dept, date) -> accumulated values

    with table.batch_writer() as batch:
        for day_idx, date_str in enumerate(dates):
            day_dt = datetime.strptime(date_str, "%Y-%m-%d")
            wk_factor = weekend_factor(day_dt)

            for user in users:
                activity = user_activity_pattern(user["idx"], day_idx) * wk_factor
                if activity < 0.05:
                    continue  # some days users are inactive

                # Determine how many requests this user makes today
                lo, hi = user["intensity"]
                base_requests = random.randint(lo, hi)
                day_requests = max(1, int(base_requests * activity))

                # Group requests by model for this day
                model_counts = {}
                for _ in range(day_requests):
                    m = weighted_choice(user["model_weights"])
                    model_counts[m] = model_counts.get(m, 0) + 1

                scale_lo, scale_hi = user["token_scale"]

                for model, req_count in model_counts.items():
                    scale = random.uniform(scale_lo, scale_hi)
                    # Aggregate tokens across all requests for this user-date-model
                    total_inp = 0
                    total_out = 0
                    total_lat = 0
                    for _ in range(req_count):
                        inp, out = gen_token_counts(model, scale)
                        total_inp += inp
                        total_out += out
                        total_lat += gen_latency(model, out)

                    cost = estimate_cost(model, total_inp, total_out)

                    # Write user record
                    item = {
                        "PK": f"USER#{user['username']}",
                        "SK": f"{date_str}#{model}",
                        "department": user["department"],
                        "model": model,
                        "date": date_str,
                        "inputTokens": total_inp,
                        "outputTokens": total_out,
                        "totalTokens": total_inp + total_out,
                        "requests": req_count,
                        "estimatedCost": Decimal(str(round(cost, 6))),
                        "latencySumMs": total_lat,
                        "updatedAt": datetime.utcnow().isoformat(),
                    }
                    batch.put_item(Item=item)
                    total_records += 1
                    total_requests += req_count
                    total_cost += cost

                    # Accumulate department aggregate
                    dk = (user["department"], date_str)
                    agg = dept_aggregates.get(dk, {
                        "inputTokens": 0, "outputTokens": 0,
                        "totalTokens": 0, "requests": 0,
                        "estimatedCost": 0.0, "latencySumMs": 0,
                    })
                    agg["inputTokens"] += total_inp
                    agg["outputTokens"] += total_out
                    agg["totalTokens"] += total_inp + total_out
                    agg["requests"] += req_count
                    agg["estimatedCost"] += cost
                    agg["latencySumMs"] += total_lat
                    dept_aggregates[dk] = agg

            if (day_idx + 1) % 5 == 0:
                print(f"  Day {day_idx + 1}/{NUM_DAYS}: {date_str} — {total_records} records so far")

        # Write department aggregates
        for (dept, date_str), agg in dept_aggregates.items():
            batch.put_item(Item={
                "PK": f"DEPT#{dept}",
                "SK": date_str,
                "inputTokens": agg["inputTokens"],
                "outputTokens": agg["outputTokens"],
                "totalTokens": agg["totalTokens"],
                "requests": agg["requests"],
                "estimatedCost": Decimal(str(round(agg["estimatedCost"], 6))),
                "latencySumMs": agg["latencySumMs"],
                "updatedAt": datetime.utcnow().isoformat(),
            })

    print()
    print("=" * 60)
    print(f"  Total records:   {total_records:,} (user) + {len(dept_aggregates):,} (dept)")
    print(f"  Total requests:  {total_requests:,}")
    print(f"  Total cost:      ${total_cost:,.2f}")
    print(f"  Avg cost/user:   ${total_cost / len(users):,.2f}")
    print(f"  Period:          {dates[0]} ~ {dates[-1]}")
    print("=" * 60)

    # Per-department summary
    print()
    print("Department Breakdown:")
    for dept in DEPARTMENTS:
        dept_cost = sum(v["estimatedCost"] for (d, _), v in dept_aggregates.items() if d == dept)
        dept_reqs = sum(v["requests"] for (d, _), v in dept_aggregates.items() if d == dept)
        dept_tokens = sum(v["totalTokens"] for (d, _), v in dept_aggregates.items() if d == dept)
        print(f"  {dept:15s}: {dept_reqs:>8,} reqs | {dept_tokens:>14,} tokens | ${dept_cost:>10,.2f}")

    # Per-model summary
    print()
    print("Model Breakdown:")
    model_stats = {}
    for (dept, date_str), agg in dept_aggregates.items():
        pass  # dept aggregates don't have model; skip
    # Re-scan from raw approach
    print("  (See DynamoDB for per-model breakdown)")


if __name__ == "__main__":
    generate_data()
