# CC-ON-BEDROCK Design System

Unified design language for the cc-on-bedrock enterprise dashboard.
Linear, Vercel Dashboard 수준의 정제된 다크 테마를 목표로 한다.

## 1. Design Principles

- **Precision over Fluff**: 모든 시각 요소는 기능적 목적에 부합. 과도한 glassmorphism, glow 금지.
- **Subtle Hierarchy**: 3단계 surface depth + text contrast로 정보 계층 표현. 강한 border 대신 background 차이.
- **Density for Power Users**: 클라우드 아키텍트에게 필요한 데이터를 한눈에 제공. 정보 밀도 우선.
- **Systemic Consistency**: Home이든 Analytics든 동일한 컴포넌트가 동일하게 보여야 한다.

## 2. Color System (Dark Only)

### Surface Hierarchy (3-tier)

| Level | Name | Value | Tailwind | Usage |
|-------|------|-------|----------|-------|
| L0 | Base | `#0a0f1a` | `bg-[#0a0f1a]` | Page background |
| L1 | Surface | `#111827` | `bg-gray-900` | Cards, sidebar, panels |
| L2 | Elevated | `#1f2937` | `bg-gray-800` | Hover states, tooltips, dropdowns, active items |

> **금지**: `#161b22`, `#161b22/40`, `#0d1117` 등 커스텀 hex 배경색 사용 금지.
> L0/L1/L2만 사용하여 일관성 유지.

### Text Hierarchy

| Level | Value | Tailwind | Usage |
|-------|-------|----------|-------|
| Primary | `#f9fafb` | `text-gray-50` | Headings, stat values, active labels |
| Secondary | `#9ca3af` | `text-gray-400` | Descriptions, inactive nav, labels |
| Muted | `#6b7280` | `text-gray-500` | Metadata, timestamps, disabled |

### Semantic Colors

| State | Text | Background | Border |
|-------|------|------------|--------|
| Success | `text-emerald-400` | `bg-emerald-500/10` | `border-emerald-500/20` |
| Warning | `text-amber-400` | `bg-amber-500/10` | `border-amber-500/20` |
| Error | `text-red-400` | `bg-red-500/10` | `border-red-500/20` |
| Info | `text-blue-400` | `bg-blue-500/10` | `border-blue-500/20` |

### Accent

- Primary: `#3b82f6` (`blue-500`) — brand color, links, active states
- Hover: `#2563eb` (`blue-600`)

## 3. Typography Scale

Font: **Inter** (sans-serif). Mono: `font-mono` for IDs, ARNs, CLI output.

| Level | Tailwind Class | Usage |
|-------|---------------|-------|
| Page Title | `text-2xl font-bold tracking-tight` | Page headers (Analytics, Security...) |
| Section Header | `text-xs font-semibold uppercase tracking-wider text-gray-400` | Section dividers |
| Card Title | `text-lg font-semibold text-gray-50` | Card headings |
| Stat Value | `text-3xl font-bold text-gray-50 tracking-tight` | Big numbers |
| Body | `text-sm text-gray-400` | Descriptions, paragraphs |
| Label | `text-xs font-medium text-gray-500` | Form labels, table headers |
| Micro | `text-[11px] text-gray-500` | Tooltips, timestamps |
| Mono | `font-mono text-[13px] text-gray-300` | Resource IDs, commands |

> **금지**: `font-black` (weight 900) 전면 금지. Headings는 `font-bold`(700), labels는 `font-semibold`(600) 또는 `font-medium`(500).

## 4. Spacing & Layout

4px grid 기반.

| Element | Value |
|---------|-------|
| Page padding | `px-6 py-8 lg:px-8` |
| Page max-width | `max-w-[1600px] mx-auto` |
| Section gap | `space-y-8` |
| Card padding | `p-6` (standard), `p-5` (compact) |
| Grid gap | `gap-6` |
| Inner spacing | `space-y-4` |
| Button gap | `gap-2` |

## 5. Component Tokens

### Cards

```
Standard:    bg-gray-900 border border-gray-800 rounded-xl p-6
Interactive: bg-gray-900 border border-gray-800 rounded-xl p-6
             hover:border-blue-500/30 hover:bg-gray-800/50 transition-all
Stat:        bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm
```

> **금지**: `backdrop-blur-md`, `bg-[#161b22]/40`, `shadow-2xl` 등 글라스모피즘 효과.
> 깔끔한 L1 배경 + subtle border가 카드의 기본.

### Buttons

```
Primary:   bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg
           font-medium transition-colors
Secondary: bg-gray-800 hover:bg-gray-700 text-gray-100 border border-gray-700
           px-4 py-2 rounded-lg transition-colors
Ghost:     text-gray-400 hover:text-white hover:bg-gray-800/50
           p-2 rounded-lg transition-all
Danger:    bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg
```

### Badges

```
Base:     px-2 py-0.5 rounded-full text-[11px] font-semibold border
Success:  bg-emerald-500/10 text-emerald-400 border-emerald-500/20
Warning:  bg-amber-500/10 text-amber-400 border-amber-500/20
Error:    bg-red-500/10 text-red-400 border-red-500/20
Info:     bg-blue-500/10 text-blue-400 border-blue-500/20
Neutral:  bg-gray-800 text-gray-400 border-gray-700
```

### Form Inputs

```
bg-[#0a0f1a] border border-gray-800 text-sm text-gray-50 rounded-lg
focus:ring-1 focus:ring-blue-500 focus:border-blue-500
placeholder-gray-500 p-2.5
```

### Tables

```
Header:   bg-gray-900 text-xs font-semibold uppercase tracking-wider text-gray-400
Row:      border-b border-gray-800/50 hover:bg-gray-800/30
Cell:     px-4 py-3 text-sm text-gray-300
```

## 6. Border & Shadow

### Border Colors

| Usage | Value |
|-------|-------|
| Card border | `border-gray-800` |
| Subtle separator | `border-gray-800/50` |
| Focus | `border-blue-500` |
| Hover accent | `border-blue-500/30` |

> **금지**: `border-white/5`, `border-white/10` — gray-800 계열로 통일.

### Border Radius

| Usage | Value |
|-------|-------|
| Cards, modals | `rounded-xl` (12px) |
| Buttons, inputs | `rounded-lg` (8px) |
| Badges, dots | `rounded-full` |
| Large sections | `rounded-2xl` (16px) — 홈 히어로 섹션만 |

> **금지**: `rounded-3xl` (24px) 사용 금지.

### Shadows

| Level | Value | Usage |
|-------|-------|-------|
| Subtle | `shadow-sm` | Cards at rest |
| Medium | `shadow-lg shadow-black/20` | Hover cards, elevated panels |
| Heavy | `shadow-2xl shadow-black/50` | Modals, command palette |

## 7. Motion (Framer Motion)

빠르고 스낵한 애니메이션. 과도한 spring/bounce 금지.

```tsx
// Card/Section entrance
initial={{ opacity: 0, y: 8 }}
animate={{ opacity: 1, y: 0 }}
transition={{ duration: 0.2, ease: "easeOut" }}

// Hover lift (cards only, subtle)
whileHover={{ y: -2 }}
transition={{ duration: 0.15 }}

// Stagger children
transition={{ staggerChildren: 0.05 }}

// Page transition
initial={{ opacity: 0 }} animate={{ opacity: 1 }}
transition={{ duration: 0.15 }}
```

> **금지**: `whileHover={{ y: -4 }}` (너무 과장), `shadow-primary-500/10` glow 효과.

## 8. Chart Theming (Recharts)

### Colors (순서대로 사용)

```
["#3b82f6", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#84cc16"]
```

### Tooltip (통일)

```tsx
contentStyle={{
  backgroundColor: "#1f2937",
  border: "1px solid #374151",
  borderRadius: "8px",
  color: "#f3f4f6",
  fontSize: 12,
  boxShadow: "0 10px 15px -3px rgba(0,0,0,0.5)",
}}
```

### Grid & Axis

```tsx
<CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
<XAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
<YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
```

## 9. Icon Guidelines

- Library: **Lucide React**
- Default size: 18px (`w-[18px] h-[18px]`)
- Inline size: 14px
- Stroke: `strokeWidth={1.5}`
- Color: `text-gray-400` (default), `text-blue-500` (active)
- 아이콘은 라벨을 보강하는 용도. 네비게이션에서 아이콘만으로 라벨을 대체하지 않는다.

## 10. Migration Checklist

현재 코드에서 제거/교체해야 할 패턴:

| Before (삭제) | After (교체) |
|--------------|-------------|
| `bg-[#161b22]`, `bg-[#161b22]/40`, `bg-[#0d1117]` | `bg-gray-900` (L1) |
| `bg-[#111827]` | `bg-gray-900` (L1) |
| `border-white/5`, `border-white/10` | `border-gray-800` |
| `border-gray-700` (카드 경계) | `border-gray-800` |
| `font-black` (모든 곳) | `font-bold` |
| `tracking-tighter`, `tracking-[0.3em]` | `tracking-tight` (headings), `tracking-wider` (labels) |
| `backdrop-blur-md` | 제거 |
| `rounded-3xl` | `rounded-xl` 또는 `rounded-2xl` |
| `shadow-2xl` (카드) | `shadow-sm` |
| `text-white` | `text-gray-50` |
| `whileHover={{ y: -4 }}` | `whileHover={{ y: -2 }}` |
