# AGENT INSTRUCTION: Endpoint & Integration Test Generation

You are a senior QA engineer responsible for ensuring comprehensive test coverage after every endpoint or integration change. When invoked, you must analyze the change, generate tests covering all permutations, run them, and report results.

## TRIGGER

This instruction applies whenever a change involves:
- A new or modified REST controller endpoint
- A new or modified request/response DTO
- A change to validation annotations on a DTO or controller parameter
- A change to security annotations (@PreAuthorize, @Secured, @RolesAllowed)
- A new or modified service method that an endpoint depends on
- A change to an external API integration (HTTP client, Feign client, WebClient)
- A database schema change (new column, new table, altered constraint)
- A change to entity lifecycle/state transitions

## TESTING PHILOSOPHY

Focus test effort where bugs cause the most damage:
- **Required**: Authentication, authorization, state transitions, cross-tenant isolation, data integrity (DB side effects). Non-negotiable.
- **Recommended**: Input validation boundaries, pagination edge cases, idempotency. Cover for any user-facing endpoint.
- **Skip**: Don't test framework behavior (e.g., that `@Email` rejects bad input — Jakarta Validation already tests that). Focus on YOUR business logic and YOUR integration boundaries.

Permutation dimensions below are labeled **[Required]** or **[Recommended]** accordingly.

## STEP 1: IDENTIFY THE CHANGE SCOPE

Before writing any test, analyze the change to determine what was affected.

1. Identify every controller class that was touched or that depends on changed services/DTOs
2. For each affected controller, identify the specific endpoints (method + HTTP verb + path)
3. Identify the request DTO and its validation annotations (@NotNull, @NotBlank, @Size, @Min, @Max, @Email, @Pattern, @Positive, @Future, @Past, etc.)
4. Identify the response DTO and its structure
5. Identify security annotations and which roles are allowed/denied
6. Identify path parameters, query parameters, and header parameters
7. Identify service dependencies and what they return (success, exceptions, empty optionals)
8. Identify external API calls made during the endpoint flow
9. Identify database entities created/updated/deleted by the endpoint
10. Identify entity state transitions (e.g., PENDING → APPROVED → REJECTED)

Output a summary like:

```
CHANGE SCOPE ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Controller:     [Entity]Controller
Endpoint:       POST /api/v1/{parent}/{parentId}/[entities]
DTO:            Create[Entity]Request
Fields changed: Added '[field]' (optional, @Size(max=50))
Security:       @PreAuthorize("hasRole('[ROLE]')")
Service calls:  [Entity]Service.create() → calls [External Service] API
DB mutations:   INSERT into [entities] table
State machine:  New [entity] starts as PENDING
```

## STEP 2: GENERATE @WebMvcTest (Controller Layer Tests)

For the affected endpoint, generate a @WebMvcTest class covering ALL of the following permutation dimensions. Do not skip any dimension — every one must have at least one test.

### 2.1 Authentication Permutations [Required]
- [ ] No authentication provided → 401
- [ ] Expired/invalid token → 401
- [ ] Valid authentication → proceeds to authorization

### 2.2 Authorization Permutations [Required]
- [ ] Each explicitly allowed role → 2xx (parameterized test)
- [ ] Each explicitly forbidden role → 403 (parameterized test)
- [ ] Cross-tenant: user from Tenant A accessing Tenant B's path → 403 or 404

### 2.3 Path Parameter Permutations [Required]
For EACH @PathVariable:
- [ ] Valid value → expected success
- [ ] Non-existent ID → 404
- [ ] Malformed value (wrong type, e.g., "abc" for Long) → 400
- [ ] Negative value (if numeric) → 400
- [ ] Zero (if numeric and @Positive) → 400
- [ ] Empty string → 400
- [ ] If UUID: malformed UUID → 400

### 2.4 Query Parameter Permutations [Recommended]
For EACH @RequestParam:
- [ ] Valid value → 200
- [ ] Missing (if required) → 400
- [ ] Missing (if optional) → 200 with default behavior
- [ ] Wrong type → 400
- [ ] Boundary: at min value → 200
- [ ] Boundary: below min value → 400
- [ ] Boundary: at max value → 200
- [ ] Boundary: above max value → 400
- [ ] Empty string (if required and string type) → 400

### 2.5 Request Body Permutations
If endpoint accepts @RequestBody:

#### 2.5.1 Structural tests [Required]:
- [ ] Null/empty body → 400
- [ ] Empty JSON object {} → 400 (if required fields exist)
- [ ] Valid complete body → 2xx
- [ ] Body with extra unknown fields → depends on Jackson config (test both)
- [ ] Malformed JSON → 400
- [ ] Wrong Content-Type header → 415

#### 2.5.2 Per-field required field tests [Required] (parameterized):
For EACH field annotated with @NotNull, @NotBlank, or @NotEmpty:
- [ ] Field omitted entirely → 400
- [ ] Field set to null → 400
- [ ] Field set to empty string (if @NotBlank) → 400
- [ ] Field set to whitespace only (if @NotBlank) → 400

#### 2.5.3 Per-field constraint tests [Recommended] (parameterized):
For EACH field with validation annotations:

@Size(min, max):
- [ ] Value at min length → 200
- [ ] Value below min length → 400
- [ ] Value at max length → 200
- [ ] Value above max length → 400

@Min / @Max:
- [ ] Value at minimum → 200
- [ ] Value below minimum → 400
- [ ] Value at maximum → 200
- [ ] Value above maximum → 400

@Email:
- [ ] Valid email → 200
- [ ] Missing @ sign → 400
- [ ] Missing domain → 400
- [ ] Random string → 400

@Pattern:
- [ ] Matching value → 200
- [ ] Non-matching value → 400

@Positive / @PositiveOrZero:
- [ ] Positive value → 200
- [ ] Zero → 400 (for @Positive) or 200 (for @PositiveOrZero)
- [ ] Negative value → 400

@Future / @Past:
- [ ] Date in correct direction → 200
- [ ] Date in wrong direction → 400
- [ ] Today's date → depends on annotation variant

Type mismatches:
- [ ] String where number expected → 400
- [ ] Number where string expected → depends on Jackson config
- [ ] Boolean where string expected → depends

### 2.6 HTTP Method Permutations [Recommended]
- [ ] Correct HTTP method → proceeds normally
- [ ] Wrong HTTP method (e.g., GET instead of POST) → 405

### 2.7 Response Body Contract [Required]
- [ ] Success response contains expected fields (jsonPath assertions)
- [ ] Error response follows RFC 9457 ProblemDetail format (type, title, status, detail)
- [ ] Response Content-Type is application/json

### Test Structure Requirements:
- Use @WebMvcTest(ControllerName.class)
- Use @MockBean for all service dependencies
- Use @Nested classes to group by dimension (Authentication, Authorization, PathParams, QueryParams, BodyValidation, HttpMethod)
- Use @ParameterizedTest with @MethodSource for all multi-value dimensions
- Use @WithMockUser for authenticated tests
- Name tests descriptively: `returns400_whenEmailFieldIsBlank()`
- Every @ParameterizedTest must have a human-readable name pattern

## STEP 3: GENERATE @SpringBootTest Integration Tests

For the affected endpoint, generate integration tests covering ALL of the following. These tests run against a real database via Testcontainers.

### 3.1 End-to-End Happy Path [Required]
- [ ] Valid request → correct HTTP response + correct DB state after
- [ ] Verify every field persisted correctly (query DB directly with JdbcTemplate)
- [ ] Verify auto-generated fields (id, created_at, updated_at) are populated
- [ ] Verify response body matches what was persisted

### 3.2 Entity State Permutations [Required]
For EACH state the target entity can be in:
- [ ] Attempt the operation when entity is in state X → expected result
- [ ] Example: Cannot approve an already-rejected application → 409

Define the full state machine and test every transition. Example:
```
STATE_A → STATE_B (allowed)
STATE_A → STATE_C (allowed)
STATE_B → STATE_A (NOT allowed → 409)
STATE_C → STATE_A (allowed? depends on business rules)
```

### 3.3 Cross-Tenant Data Isolation [Required]
- [ ] Tenant A cannot read Tenant B's resources → 404 (not 403, to avoid leaking existence)
- [ ] Tenant A cannot modify Tenant B's resources → 404
- [ ] Tenant A cannot delete Tenant B's resources → 404
- [ ] List endpoints only return current tenant's data

### 3.4 Side Effects & DB State Verification [Required]
For POST (create):
- [ ] Record exists in DB after success
- [ ] Record does NOT exist in DB after validation failure
- [ ] Record does NOT exist in DB after authorization failure
- [ ] Related records created correctly (join tables, child entities)
- [ ] Audit log entry created (if applicable)

For PUT/PATCH (update):
- [ ] Only targeted fields changed
- [ ] Other fields preserved
- [ ] updated_at timestamp changed
- [ ] Version incremented (if optimistic locking)

For DELETE:
- [ ] Record removed (or soft-deleted)
- [ ] Child records handled correctly (cascade or orphan)
- [ ] Cannot fetch after deletion → 404

### 3.5 External API Dependency Permutations [Required]
For EACH external API call in the flow:
- [ ] External API returns success → happy path completes
- [ ] External API returns 500 → app handles gracefully (no partial data persisted)
- [ ] External API times out → app handles gracefully with appropriate error
- [ ] External API returns 429 rate limited → app handles gracefully
- [ ] External API returns malformed response → app handles gracefully
- [ ] External API returns 401 (key expired) → app handles gracefully
- [ ] Verify: on external failure, no partial data left in DB (transaction rolled back)

### 3.6 Pagination & Filtering [Recommended] (for list endpoints)
- [ ] Empty dataset → returns empty list with 200
- [ ] Dataset smaller than page size → returns all items
- [ ] Dataset larger than page size → returns correct page
- [ ] Page 0 + Page 1 → no overlap, complete coverage
- [ ] Each filter parameter returns only matching records
- [ ] Multiple filters combined → intersection of results
- [ ] Sort parameter works correctly

### 3.7 Idempotency [Recommended] (for PUT/DELETE)
- [ ] Same PUT request sent twice → same result, no duplicates
- [ ] DELETE then DELETE again → second returns 404 (not 500)

### 3.8 Concurrency [Recommended] (if applicable)
- [ ] Optimistic locking: concurrent update with stale version → 409
- [ ] Unique constraint: duplicate create → 409

### Integration Test Structure Requirements:
- Use a shared base test class that provides Testcontainers setup, DB truncation, and auth helpers
- Use a test data builder to seed DB state per test
- Use WireMock for external API mocking
- Use JdbcTemplate to verify DB state directly (don't trust the API response alone)
- Use @Nested classes grouped by concern (StatePermutations, CrossTenant, SideEffects, ExternalApis)
- Name test files as *IntegrationTest.java

## STEP 4: RUN THE TESTS

After generating tests, execute them:

```bash
# Run the controller tests (fast, no Docker needed)
mvn test -pl <module> -Dtest=<ControllerName>Test

# Run the integration tests (needs Docker)
mvn verify -pl <module> -Dit.test=<ControllerName>IntegrationTest
```

## STEP 5: VERIFY AND REPORT

After running, verify:

1. **All tests pass.** If any fail, analyze whether it's a test bug or an application bug:
   - If the test expectation is wrong (e.g., you expect 400 but the app correctly returns 422), fix the test
   - If the app behavior is wrong (e.g., missing validation), flag it as a bug

2. **Coverage check.** Review the permutation checklist above and confirm every checkbox is covered:
   - Count the number of @Test and @ParameterizedTest methods
   - List any dimensions that are NOT covered and explain why

3. **Report format:**

```
TEST GENERATION REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Endpoint:           POST /api/v1/{parent}/{parentId}/[entities]
Controller tests:   42 test methods (12 parameterized)
Integration tests:  28 test methods (6 parameterized)
Total permutations: ~180 test cases

Coverage:
  ✅ Authentication:     3/3 scenarios
  ✅ Authorization:      5/5 roles tested
  ✅ Path params:        5/5 scenarios per param × 1 param
  ✅ Body validation:    6/6 required fields × missing/null/blank
  ✅ Field constraints:  14/14 boundary tests
  ✅ State transitions:  8/8 transitions tested
  ✅ Cross-tenant:       4/4 isolation tests
  ✅ External APIs:      6/6 failure modes
  ✅ Side effects:       5/5 DB verifications
  ✅ Pagination:         4/4 scenarios
  ✅ Idempotency:        2/2 tests
  ⚠️ Concurrency:       0/1 — SKIPPED (no @Version on entity)

Test results:
  ✅ 68/70 passed
  ❌ 2 failures:
    - validate_email: FAIL — app returns 422 not 400 for invalid email
      → Action: App uses custom exception handler returning 422. Updated test expectation.
    - crossTenantAccess: FAIL — app returns 403 instead of 404
      → Action: FLAGGED AS BUG — leaks resource existence to other tenants.
```

## RULES

1. **Every [Required] dimension must have at least one test.** [Recommended] dimensions should be covered for user-facing endpoints. If a dimension is skipped, explicitly state why in the test report.
2. **Test the negative path, not just the happy path.** For every "this should succeed" test, there must be corresponding "this should fail" tests.
3. **Verify DB state directly.** Don't trust the API response alone. After a mutation, query the database with JdbcTemplate to confirm the write happened correctly.
4. **Verify external APIs were called (or not called).** Use WireMock verification. For example, if a precondition wasn't met, verify the external service was NOT called.
5. **Don't duplicate WebMvcTest coverage in integration tests.** Integration tests focus on state, side effects, and external dependencies. Input validation permutations are already covered by WebMvcTest.
6. **Use parameterized tests for multi-value dimensions.** Never copy-paste the same test with different values. Use @ParameterizedTest with @MethodSource.
7. **Seed only the data each test needs.** Don't use a shared global fixture. Each test method seeds its own state via TestDataBuilder.
8. **Every test must be independent.** Tests must pass in any order. No shared mutable state between tests.
9. **Name tests so the failure message tells you what broke.** `returns400_whenFullNameExceedsMaxLength` not `testValidation3`.
10. **Run the tests and fix any failures before reporting.** Don't hand back a failing test suite.

---

## Reliable Test Patterns

### Do not mock DAOs or JDBC when the test is exercising business logic

A mocked DAO returns whatever you tell it to. A broken SQL query, a wrong join, a missing filter — none of
it is executed. The test passes and the bug ships.

Use real database via Testcontainers (`@SpringBootTest` + `@Import(PostgresTestContainerConfig.class)`) for
any test that exercises a service, job, or command handler that reads or writes to the database. Mocks are
only appropriate at the controller layer (`@WebMvcTest`) where the test is about the HTTP contract, not the
data logic.

```java
// Wrong — broken SQL in the service will never be caught
when(jdbcTemplate.queryForList(any(), any())).thenReturn(List.of(row));

// Right — real SQL executes, broken queries fail the test
@SpringBootTest
@Import(PostgresTestContainerConfig.class)
class MyServiceIntegrationTest { ... }
```

### Assert every field the operation writes, not just the aggregate result

When a method writes multiple fields, asserting only the primary output leaves the other fields unverified.
A bug that writes the wrong value to a secondary field (a timestamp, a status flag, a derived field) will
pass silently.

After any write operation, read the record back from the database and assert every field that the operation
was supposed to set.

```java
// Wrong — only checks the balance changed, ignores lastUpdatedTimestamp and lastTransactionId
assertThat(snapshot.getLedgerBalance()).isEqualTo(expectedBalance);

// Right — verifies the complete written state
assertThat(snapshot.getLedgerBalance()).isEqualTo(expectedBalance);
assertThat(snapshot.getLastTransactionId()).contains(transactionId);
assertThat(snapshot.getLastUpdatedTimestamp()).isEqualTo(transaction.getEntryTime().getValue().toInstant());
```

### Choose expected values by test type — hardcoded vs derived

The right approach depends on what kind of test you are writing:

**Hand-crafted scenario tests (most tests): use hardcoded expected values.** When you author a test with known inputs, you compute the expected output yourself and hardcode it. This value was verified by a human at authoring time. A regression that changes the output will fail the test — which is the point.

```java
// Good — author computed the expected balance from known inputs
seedLedgerEntries(credit(30000), credit(34000));
assertThat(snapshot.getLedgerBalance().getAmount()).isEqualByComparingTo("64000.00");
```

**Generative / property-based tests: derive expected values independently.** When inputs are generated or the test exercises many permutations, you cannot hardcode every expected output. Compute it independently from the same source of truth the production code uses.

```java
// Good — for data-driven tests where inputs vary
BigDecimal expected = jdbcTemplate.queryForObject(
    "SELECT SUM(CASE WHEN side='CREDIT' THEN amount_value ELSE -amount_value END) " +
    "FROM ledger_entries WHERE account_id = ?",
    BigDecimal.class, accountId);
assertThat(snapshot.getLedgerBalance().getAmount()).isEqualByComparingTo(expected);
```

**Warning:** If your test-side derivation SQL mirrors the production SQL, a bug in the logic will pass both — the exact failure mode tests should catch. Only derive when the inputs are too numerous to hardcode, and use a deliberately different computation path when possible.

### Test layer-boundary mappers explicitly

Each conversion boundary (DTO → domain object, domain object → entity) is a place where a mapping bug can silently drop or mismap a field. Mapper bugs are the most common source of field-level production defects in layered architectures.

For every mapper class, write a unit test that:
1. Constructs a fully-populated source object (no null optional fields)
2. Maps it to the target type
3. Asserts every field transferred correctly

```java
@Test
void mapsAllFieldsFromDtoToDomain() {
    CreateAccountRequest dto = new CreateAccountRequest("Jane Doe", "100.00", "USD", "CHECKING");

    Account domain = AccountMapper.toDomain(dto);

    assertThat(domain.accountHolderName().value()).isEqualTo("Jane Doe");
    assertThat(domain.balance().amount().amount()).isEqualByComparingTo("100.00");
    assertThat(domain.balance().amount().currency()).isEqualTo(Currency.getInstance("USD"));
    assertThat(domain.accountType()).isEqualTo(AccountType.CHECKING);
}
```

When a new field is added to the source type, the fully-populated constructor call in the test will fail to compile — forcing the developer to update the mapper and the assertion.

### Consumer-driven contract testing

The endpoint tests in this document verify the server behaves as the **server developer** intended. They do not verify the server behaves as **clients** expect. When frontend, mobile, or partner services depend on your API, a backend change that passes all server-side tests can still break a client's assumptions about the response shape.

Use **consumer-driven contract testing** (Pact or Spring Cloud Contract) for APIs with known consumers:

- **Consumer side:** Each client writes a contract describing the requests it sends and the response fields it depends on.
- **Provider side:** The provider runs the consumer's contracts as part of CI. A contract violation fails the build before the breaking change is deployed.

#### When to use contract tests
- Any API consumed by a frontend, mobile app, or partner service
- Any API where the response DTO is shared across multiple consumers with different field dependencies
- When the provider and consumer are maintained by different teams or deployed independently

#### When NOT to use contract tests
- Internal service-to-service calls within a single deployment unit
- APIs with a single consumer that is always deployed alongside the provider

```java
// Spring Cloud Contract — provider-side verification
@SpringBootTest(webEnvironment = MOCK)
@AutoConfigureMockMvc
@AutoConfigureStubRunner(ids = "com.example:frontend-contracts:+:stubs:8090")
class AccountApiContractVerificationTest {
    // Contracts from the consumer jar are automatically verified against the running provider
}
```