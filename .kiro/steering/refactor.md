# Refactor

Refactor existing code to improve quality without changing behavior.

## Principles
- Improve structure without changing behavior
- Single Responsibility Principle (SRP)
- Remove duplicate code (DRY)
- Small, incremental steps with verification

## Process
1. **Analysis** - Identify target code, map callers/dependencies, confirm test coverage
2. **Plan** - Present what will change, what won't, risk assessment (low/medium/high)
3. **Execute** - Small verifiable steps, run tests after each step, atomic commits
4. **Verify** - All existing tests pass, no behavior changes
