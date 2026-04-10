# Well-Architected Framework (Evolved)

## Table of Contents
1. [Introduction](#introduction)
2. [Technology Stack](#technology-stack)
3. [Architectural Principles](#architectural-principles)
4. [Application Structure](#application-structure)
   - [API Layer](#api-layer)
   - [Business Logic Layer](#business-logic-layer)
   - [Data Layer](#data-layer)
5. [Best Practices](#best-practices)
   - [Validation with Preconditions](#validation-with-preconditions)
   - [Error Handling](#error-handling)
   - [Frontend Error Handling](#frontend-error-handling)
   - [Logging & Monitoring](#logging--monitoring)
   - [Security](#security)
   - [Performance](#performance)
   - [Testing](#testing)
6. [DevOps Considerations](#devops-considerations)
7. [Appendix](#appendix)

## Introduction

This document outlines the well-architected framework for building enterprise applications. It provides guidelines, best practices, and standards to ensure applications are robust, secure, maintainable, and scalable.

Applications following this framework must adhere to requirements for:
- Security and compliance
- High reliability and availability
- Data integrity and consistency
- Performance under varying loads
- Auditability and traceability

## Technology Stack

Our standard technology stack consists of:

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Language | Java 23+ | Industry standard with strong typing, mature ecosystem, and excellent support for enterprise applications |
| Framework | Spring Boot | Provides robust infrastructure, dependency injection, and simplifies configuration |
| Database | PostgreSQL | Enterprise-grade relational database with advanced features suited for financial transactions |
| Message Queue | RabbitMQ (optional) | Reliable message queue for asynchronous communication; use when the architecture requires decoupled messaging |
| Caching | Redis (optional) | In-memory data structure store for high-performance caching; use when the architecture requires caching |
| Validation | Google Guava Preconditions | Clear, concise validation with meaningful error messages |

## Architectural Principles

Our architecture adheres to the following core principles:

1. **Separation of Concerns**: Clear boundaries between different layers and components
2. **Domain-Driven Design**: Aligning code structure with business domains
3. **Immutability**: Preferring immutable data structures for improved thread safety and reasoning
4. **Clean Code**: Writing code that is readable, maintainable, and testable
5. **Defense in Depth**: Multiple layers of security controls
6. **Fail Fast**: Detecting and addressing failures as early as possible using Preconditions
7. **Strong Consistency**: Ensuring data integrity for all business-critical transactions
8. **SOLID Principles**: Following established object-oriented design principles

### Modern Java (23+)
- **Sealed interfaces**: Use for domain type hierarchies requiring exhaustive handling (e.g., `sealed interface PaymentMethod permits CreditCard, BankTransfer, Wallet`). The compiler enforces all subtypes are handled.
- **Pattern matching**: Use `switch` expressions with pattern matching for type-safe dispatch over sealed hierarchies. Replaces visitor pattern and `instanceof` chains.
- **Virtual threads**: The preferred concurrency model. Write synchronous, blocking code in command handlers and let the virtual thread scheduler handle scalability. Avoid `CompletableFuture` chains for request-scoped work. **See the Virtual Thread Pitfalls section below — there are critical gotchas.**
- **Records**: Use for simple value types without complex invariants. See Business Logic Layer guidance for when to use records vs Immutables.

## Application Structure

Our applications follow a layered architecture pattern with three primary layers:

### API Layer

This layer serves as the interface to the outside world, handling all incoming requests and outgoing responses.

#### Key Components:
- **Controllers**: Handle HTTP requests and responses (REST APIs)
- **DTOs (Data Transfer Objects)**: Represent incoming/outgoing data structures
- **Request Validators**: Validate incoming requests using Preconditions
- **Response Formatters**: Format outgoing responses

#### Guidelines:
- Controllers should be thin and delegate business logic to the service layer
- Use DTOs exclusively in this layer - they should never penetrate deeper into the application
- Implement proper input validation at this boundary using Preconditions
- Handle authentication and coarse-grained authorization here
- Standardize error responses using a consistent format
- Document APIs using OpenAPI/Swagger

```java
@RestController
@RequestMapping("/api/v1/accounts")
public class AccountController {
    private final CommandDispatcher commandDispatcher;
    private final AccountQueryHandler accountQueryHandler;
    
    @PostMapping
    public ResponseEntity<AccountCreatedResponseDTO> createAccount(
            @Valid @RequestBody CreateAccountRequestDTO requestDTO) {
        
        // @Valid handles DTO shape constraints; Preconditions are for business rules
        // Convert DTO to Command
        CreateAccountCommand command = CreateAccountCommand.builder()
            .accountHolderName(requestDTO.getAccountHolderName())
            .initialDeposit(Money.of(requestDTO.getInitialDepositAmount(), 
                                    requestDTO.getCurrency()))
            .accountType(AccountType.valueOf(requestDTO.getAccountType()))
            .build();
            
        // Execute command via dispatcher
        Account account = commandDispatcher.dispatch(command);

        // Convert domain result back to DTO
        return ResponseEntity.status(HttpStatus.CREATED)
            .body(AccountMapper.toCreatedResponseDTO(account));
    }
}
```

### Business Logic Layer

This layer contains the core business logic of the application, implementing domain rules and workflows.

#### Key Components:
- **Domain Objects**: Immutable representations of business entities with Preconditions validation
- **Commands**: Represent operations that modify state
- **Queries**: Represent operations that retrieve data
- **Command Handlers**: Process commands and apply business rules
- **Command Dispatcher**: Routes commands to appropriate handlers and manages execution
- **Query Handlers**: Process queries and return results (similar to Command Dispatcher pattern)
- **Domain Services**: Implement complex business logic spanning multiple domain objects
- **Domain Events**: Represent significant state changes in the domain

#### Two-Tier Value Object Strategy

Use **Java records** for simple value objects and **Immutables** for rich domain entities. Do not default to Immutables everywhere — the annotation processor adds compilation complexity and has known failure modes (e.g., `ImmutableXxx.Builder` return-type gotcha).

| Use Records when... | Use Immutables when... |
|---------------------|------------------------|
| Single-field wrapper (identifiers, amounts) | Multi-field entity with cross-field invariants |
| Validation is a single `checkArgument` in the compact constructor | Needs `@Value.Check` for complex invariant validation |
| No mutation methods needed | Has domain methods that return modified copies (`withXxx`) |
| DTOs, event payloads, query results | Rich domain objects with behavior (e.g., `Account.withdraw()`) |

```java
// Record — for simple value objects
public record AccountId(String value) {
    public AccountId {
        checkArgument(!Strings.isNullOrEmpty(value),
            "Account ID cannot be null or empty");
        checkArgument(VALID_PATTERN.matcher(value).matches(),
            "Account ID must match pattern ACC-XXXXXXXX-XXXX-XXXX: %s", value);
    }

    public static AccountId generate() {
        return new AccountId("ACC-" + generateRandomAlphaNumeric(8)
            + "-" + generateRandomAlphaNumeric(4) + "-" + generateRandomAlphaNumeric(4));
    }
}

// Immutables — for rich domain entities with cross-field invariants and behavior
@Value.Immutable
public abstract class Account {
    public abstract AccountId id();
    public abstract Money balance();
    public abstract AccountStatus status();

    @Value.Check
    protected void check() {
        checkArgument(status() != AccountStatus.CLOSED || balance().isZero(),
            "Closed account must have zero balance, but has: %s", balance());
    }

    public Account withdraw(Money amount) { /* returns modified copy */ }
}
```

#### Guidelines:
- Use the two-tier strategy above to choose between records and Immutables
- Use `@Value.Check` methods with Preconditions for domain object validation (null checks are covered by the Immutables library for @Value.Immutable objects)
- Wrap primitives when: the value has validation rules, is an identifier, crosses layer boundaries, or could be confused with another same-typed value (e.g., `accountId` vs `customerId`)
- Primitives are acceptable for: free-text fields without domain rules, values local to a single method, or simple counts/flags
- Command handlers execute synchronously within a transaction. With Java 23+ virtual threads, synchronous handlers provide both simplicity and scalability.
- Strong consistency must be maintained for all business-critical transactions
- Use the Query pattern for operations that retrieve data
- Domain objects should enforce their invariants through Preconditions validation methods
- Business rules should be expressed in domain terms
- Use domain events to decouple different parts of the system

#### Core Logic Purity (Critical)
Business logic that evaluates, processes, or transforms data MUST be infrastructure-free:
- **Pure domain objects in, pure domain objects out.** No Spring annotations, no repository injection, no message broker dependencies, no cache calls inside evaluators, processors, or calculators.
- **Service layer orchestrates.** The service (or command handler) fetches data from repositories/caches, passes domain objects into the pure logic, then acts on the result (persist, publish, etc.). The logic itself never reaches outward.
- **Why:** Pure logic can be exhaustively unit-tested with hundreds of edge cases in seconds — no containers, no mocks, just data in and assertions out. Integration tests then verify the plumbing separately.
- **Example separation:** A `RuleEvaluator` class takes an event and a list of rules as domain objects, returns matched alert directives. It has zero `@Autowired` fields. The `RuleEvaluationService` fetches rules from the DB, calls the evaluator, and publishes the directives to the broker.

```java
// Domain Object (Using Immutables with Preconditions)
@Value.Immutable
@Gson.TypeAdapters // create GSON adapters
@JsonSerialize(as = ImmutableAccount.class) // Allow JSON Serialize
@JsonDeserialize(as = ImmutableAccount.class) // Allow JSON Serialize
public abstract class Account {
    public abstract AccountId id();
    public abstract AccountHolderName accountHolderName();
    public abstract AccountType accountType();
    public abstract Balance balance();
    public abstract AccountStatus status();
    
    @Value.Check
    protected void check() {        
        checkArgument(status() != AccountStatus.CLOSED || balance().isZero(),
            "Closed account must have zero balance, but has: %s", balance());
        
        checkArgument(status() != AccountStatus.FROZEN || !balance().isNegative(),
            "Frozen account cannot have negative balance: %s", balance());
    }
    
    public Account deposit(Money amount) {
        checkArgument(amount.isPositive(), "Deposit amount must be positive: %s", amount);
        checkState(status().allowsDeposits(), 
            "Account status %s does not allow deposits", status());
        
        return ImmutableAccount.copyOf(this)
            .withBalance(balance().add(amount));
    }
    
    public Account withdraw(Money amount) {
        checkArgument(amount.isPositive(), "Withdrawal amount must be positive: %s", amount);
        checkState(status().allowsWithdrawals(), 
            "Account status %s does not allow withdrawals", status());
        
        Balance newBalance = balance().subtract(amount);
        checkState(newBalance.isNonNegative() || accountType().allowsOverdraft(),
            "Insufficient funds: attempted to withdraw %s from balance %s", amount, balance());
        
        return ImmutableAccount.copyOf(this)
            .withBalance(newBalance);
    }
}

// Command with Preconditions validation
@Value.Immutable
@JsonSerialize
@JsonDeserialize
public interface WithdrawFundsCommand {
    AccountId accountId();
    Money amount();
    WithdrawalReason reason();
    
    @Value.Check
    default void check() {
        checkArgument(amount().isPositive(), 
            "Withdrawal amount must be positive: %s", amount());
    }
}

// Command Handler — synchronous within @Transactional boundary
@Service
public class WithdrawFundsCommandHandler implements CommandHandler<WithdrawFundsCommand, Account> {
    private final AccountRepository accountRepository;
    private final EventPublisher eventPublisher;

    @Override
    @Transactional
    public Account handle(WithdrawFundsCommand command) {
        checkArgument(command.amount().getAmount().compareTo(DAILY_WITHDRAWAL_LIMIT) <= 0,
            "Withdrawal amount %s exceeds daily limit %s",
            command.amount(), DAILY_WITHDRAWAL_LIMIT);

        Account account = accountRepository.findById(command.accountId())
            .orElseThrow(() -> new AccountNotFoundException(command.accountId()));

        Account updatedAccount = account.withdraw(command.amount());
        Account savedAccount = accountRepository.save(updatedAccount);

        FundsWithdrawnEvent event = ImmutableFundsWithdrawnEvent.builder()
                .accountId(savedAccount.id())
                .amount(command.amount())
                .reason(command.reason())
                .newBalance(savedAccount.balance())
                .timestamp(Instant.now())
                .build();

        eventPublisher.publish(event);

        return savedAccount;
    }
}
```

### Aggregate Boundaries & Consistency

#### Defining Aggregates
An **aggregate** is a cluster of domain objects that must be consistent as a unit. One entity is the **aggregate root** — all external access goes through the root, and one transaction modifies one aggregate.

- If two entities must always be consistent with each other (e.g., `Order` and its `OrderLines`), they belong in the same aggregate.
- If two entities can tolerate brief inconsistency (e.g., `Order` and `Inventory`), they belong in separate aggregates, coordinated via domain events.

#### Transactional Boundaries
- **One transaction = one aggregate.** A command handler loads an aggregate, applies business logic, and persists the result in a single `@Transactional` boundary.
- **Cross-aggregate coordination uses domain events.** When an operation on Aggregate A must trigger a side effect on Aggregate B, publish a domain event. The event handler runs in a separate transaction.
- **Never modify two aggregates in the same transaction.** This creates hidden coupling and makes eventual decomposition into services impossible.

```java
// ✅ Single aggregate per transaction
@Transactional
public Account handle(WithdrawFundsCommand command) {
    Account account = accountRepository.findById(command.accountId()).orElseThrow();
    Account updated = account.withdraw(command.amount());
    accountRepository.save(updated);
    eventPublisher.publish(new FundsWithdrawnEvent(updated.id(), command.amount()));
    return updated;
}

// ❌ Two aggregates in one transaction — hidden coupling
@Transactional
public void handle(TransferFundsCommand command) {
    Account source = accountRepository.findById(command.sourceId()).orElseThrow();
    Account target = accountRepository.findById(command.targetId()).orElseThrow();
    // Modifying both in one transaction locks both rows and prevents decomposition
}
```

#### Synchronous vs Asynchronous Processing

| Use synchronous (in-transaction) | Use asynchronous (RabbitMQ / domain events) |
|----------------------------------|---------------------------------------------|
| The caller needs a response with the outcome | The side effect can happen later (notifications, analytics) |
| Strong consistency is required between the write and the side effect | Eventual consistency is acceptable |
| The operation is fast (< 500ms) | The operation is slow or calls external APIs |
| Failure of the side effect should roll back the primary write | Failure should be retried independently |

#### Partial Failure Handling
- **Outbox pattern:** When publishing domain events, write the event to an `outbox` table in the same transaction as the aggregate write. A separate poller/CDC publishes to RabbitMQ. This guarantees at-least-once delivery without distributed transactions.
- **Dead-letter queues:** Every RabbitMQ consumer must configure a DLQ. Messages that fail after N retries go to the DLQ for investigation, not silent discard.
- **Idempotent consumers:** Because at-least-once delivery means duplicates, every event consumer must be idempotent — use a processed-event-id table or idempotency keys.

### Data Layer

This layer handles interactions with various data sources including databases, external services, caches, and message brokers.

#### Key Components:
- **DAOs (Data Access Objects)**: High-level interfaces for data access, agnostic of implementation
- **DAO Implementations**: Concrete implementations of DAOs with Preconditions validation
- **Repositories**: Spring Data repositories for JPA-based implementations
- **Entity Models**: Represent database entities
- **External Service Clients**: Interact with external APIs
- **Cache Managers**: Handle caching operations
- **Message Producers/Consumers**: Interact with RabbitMQ (when applicable)

#### Guidelines:
- Always define DAO interfaces that are implementation-agnostic
- Use clear naming conventions: `<DomainObject>DAO` for interfaces, `<DomainObject>DAOUsing<Technology>` for implementations. eg: AccountDAO will have an AccountDAOUsingJPA (for localstorage) or AccountDAOUsingRest (if the store is remotely accesible via Rest)
- Map between domain objects and data entities explicitly in DAO implementations
- Handle transactional boundaries at the DAO implementation level
- Implement retry and circuit-breaking patterns for external services
- Use Preconditions at DAO boundaries only for values that arrive from **external** sources (user input that bypassed the API layer, message queue payloads). Do not re-validate values that the domain layer already guarantees — this creates misleading `IllegalArgumentException` stack traces if the check fires for an unexpected reason
- Use appropriate caching strategies within DAO implementations
- Design DAOs to support multiple data access patterns (synchronous, asynchronous, streaming)

```java
// Repository interface with Preconditions validation
public interface AccountRepository {
    Optional<Account> findById(AccountId id);
    Account save(Account account);
    List<Account> findByStatus(AccountStatus status);
}

// DAO implementation — domain layer already validates AccountId and Account invariants,
// so no redundant null/format checks here. Preconditions only for values from external sources.
@Repository
public class AccountDAOUsingJPA implements AccountDAO {
    private final JpaAccountRepository jpaRepository;
    private final AccountEntityMapper mapper;
    
    @Override
    public Optional<Account> findById(AccountId id) {
        return jpaRepository.findById(id.value())
            .map(mapper::toDomain);
    }
    
    @Override
    @Transactional
    public Account save(Account account) {
        AccountEntity entity = mapper.toEntity(account);
        AccountEntity savedEntity = jpaRepository.save(entity);
        return mapper.toDomain(savedEntity);
    }
    
    @Override
    public List<Account> findByStatus(AccountStatus status) {
        return jpaRepository.findByStatus(status.name())
            .stream()
            .map(mapper::toDomain)
            .collect(toList());
    }
}
```

## Best Practices

### Validation with Preconditions

Google Guava's Preconditions provide a clean, readable way to validate method parameters, object state, and business rules.

#### Key Preconditions Methods:
- `checkArgument(condition, message, args...)`: Validates method arguments
- `checkState(condition, message, args...)`: Validates object state
- `checkArgument(obj != null, message, args...)`: Validates non-null references (prefer over `checkNotNull` for consistent exception types)
- `checkElementIndex(index, size, message)`: Validates array/list indices
- `checkPositionIndex(index, size, message)`: Validates positions in arrays/lists

#### Guidelines:
- Use `checkArgument()` for validating method parameters
- Use `checkState()` for validating object state and business rules  
- Prefer `checkArgument(obj != null, ...)` over `checkNotNull()` — throws IllegalArgumentException (already handled globally) rather than NullPointerException
- Always provide clear, descriptive error messages with context
- Include relevant values in error messages using format strings
- Place Preconditions checks at the beginning of methods
- Use `@Value.Check` methods in Immutables for object validation
- Combine multiple related checks when it makes sense

#### Immutables Static Method Gotcha

Never use the generated `ImmutableXxx.Builder` as a **return type** in the source interface. The annotation processor generates `ImmutableXxx` from the interface — referencing it in the return type creates a circular dependency that causes the processor to silently skip the class.

```java
// ❌ BROKEN — ImmutableMoney doesn't exist yet when this file is processed
static ImmutableMoney.Builder builder() {
    return ImmutableMoney.builder();
}

// ✅ CORRECT — return the interface type, call the generated type only in the body
static Money of(BigDecimal amount, Currency currency) {
    return ImmutableMoney.builder().amount(amount).currency(currency).build();
}
```

Referencing `ImmutableXxx` inside method **bodies** is fine — only the return type and parameter types matter during annotation processing. If you need a builder convenience method, return the interface type or use a factory method that calls `.build()`.

#### Validation Responsibilities
- **Bean Validation** (`@NotNull`, `@Size`, `@Email`): Declarative request validation on DTOs. Spring enforces via `@Valid` automatically.
- **Guava Preconditions**: Invariant enforcement in domain objects and business logic.
- Do not duplicate the same check in both layers.

```java
// Value Object with comprehensive Preconditions validation
@Value.Immutable
@JsonSerialize
@JsonDeserialize
public abstract class Money {
    public abstract BigDecimal amount();
    public abstract Currency currency();
    
    @Value.Check
    protected void check() {
        checkArgument(amount().scale() <= currency().getDefaultFractionDigits(),
            "Amount scale cannot exceed currency fraction digits: %s > %s",
            amount().scale(), currency().getDefaultFractionDigits());
    }
    
    public static Money of(BigDecimal amount, Currency currency) {
        checkArgument(amount.compareTo(BigDecimal.ZERO) >= 0, 
            "Amount cannot be negative: %s", amount);
        
        return ImmutableMoney.builder()
            .amount(amount.setScale(currency.getDefaultFractionDigits(), RoundingMode.HALF_UP))
            .currency(currency)
            .build();
    }
    
    public static Money zero(Currency currency) {
        checkArgument(currency != null, "Currency cannot be null");
        return of(BigDecimal.ZERO, currency);
    }
    
    public Money add(Money other) {
        checkArgument(other != null, "Other money cannot be null");
        checkArgument(currency().equals(other.currency()),
            "Cannot add different currencies: %s and %s", currency(), other.currency());
        
        return ImmutableMoney.copyOf(this)
            .withAmount(amount().add(other.amount()));
    }
    
    public Money subtract(Money other) {
        checkArgument(other != null, "Other money cannot be null");
        checkArgument(currency().equals(other.currency()),
            "Cannot subtract different currencies: %s and %s", currency(), other.currency());
        
        BigDecimal result = amount().subtract(other.amount());
        return ImmutableMoney.copyOf(this).withAmount(result);
    }
    
    public Money multiply(BigDecimal multiplier) {
        checkArgument(multiplier != null, "Multiplier cannot be null");
        checkArgument(multiplier.compareTo(BigDecimal.ZERO) >= 0,
            "Multiplier cannot be negative: %s", multiplier);
        
        return ImmutableMoney.copyOf(this)
            .withAmount(amount().multiply(multiplier)
                .setScale(currency().getDefaultFractionDigits(), RoundingMode.HALF_UP));
    }
    
    public boolean isPositive() {
        return amount().compareTo(BigDecimal.ZERO) > 0;
    }
    
    public boolean isZero() {
        return amount().compareTo(BigDecimal.ZERO) == 0;
    }
    
    public boolean isNonNegative() {
        return amount().compareTo(BigDecimal.ZERO) >= 0;
    }
}

// AccountId with validation
@Value.Immutable
@JsonSerialize(as = ImmutableAccountId.class)
@JsonDeserialize(as = ImmutableAccountId.class)
public abstract class AccountId {
    private static final Pattern VALID_ACCOUNT_ID_PATTERN = 
        Pattern.compile("^ACC-[A-Z0-9]{8}-[A-Z0-9]{4}-[A-Z0-9]{4}$");
    
    @Parameter // Single parameter objects get the @Paramete annotation
    public abstract String value();
    
    @Value.Check
    protected void check() {
        checkArgument(!Strings.isNullOrEmpty(value()), 
            "Account ID cannot be null or empty");
        checkArgument(VALID_ACCOUNT_ID_PATTERN.matcher(value()).matches(),
            "Account ID must match pattern ACC-XXXXXXXX-XXXX-XXXX: %s", value());
    }
    
    public static AccountId of(String value) {
        checkArgument(!Strings.isNullOrEmpty(value), 
            "Account ID value cannot be null or empty");
        
        return ImmutableAccountId.builder().value(value.toUpperCase()).build();
    }
    
    public static AccountId generate() {
        String id = "ACC-" + 
                   generateRandomAlphaNumeric(8) + "-" +
                   generateRandomAlphaNumeric(4) + "-" +
                   generateRandomAlphaNumeric(4);
        return of(id);
    }
}

// Balance with business rule validation
@Value.Immutable
@JsonSerialize
@JsonDeserialize
public abstract class Balance {
    public abstract Money amount();
    
    @Value.Check
    protected void check() {
      // Some invariant here
    }
    
    public static Balance of(Money amount) {
        checkArgument(amount != null, "Amount cannot be null");
        return ImmutableBalance.builder().amount(amount).build();
    }
    
    public static Balance zero(Currency currency) {
        checkArgument(currency != null, "Currency cannot be null");
        return of(Money.zero(currency));
    }
    
    public Balance add(Money amount) {
        checkArgument(amount != null, "Amount to add cannot be null");
        checkArgument(amount().currency().equals(amount.currency()),
            "Cannot add different currencies: %s and %s", 
            amount().currency(), amount.currency());
        
        return ImmutableBalance.copyOf(this)
            .withAmount(amount().add(amount));
    }
    
    public Balance subtract(Money amount) {
        checkArgument(amount != null, "Amount to subtract cannot be null");
        checkArgument(amount().currency().equals(amount.currency()),
            "Cannot subtract different currencies: %s and %s", 
            amount().currency(), amount.currency());
        
        return ImmutableBalance.copyOf(this)
            .withAmount(amount().subtract(amount));
    }
    
    public boolean isPositive() {
        return amount().isPositive();
    }
    
    public boolean isZero() {
        return amount().isZero();
    }
    
    public boolean isNegative() {
        return amount().amount().compareTo(BigDecimal.ZERO) < 0;
    }
    
    public boolean isNonNegative() {
        return amount().isNonNegative();
    }
}
```

### Error Handling

Error responses follow **RFC 9457 (Problem Details for HTTP APIs)**. Spring 6+ provides `ProblemDetail` with automatic `application/problem+json` content negotiation.

#### Domain Exception Strategy (Critical)

**Do NOT map `IllegalArgumentException` or `IllegalStateException` directly to HTTP status codes.** Third-party libraries (Jackson, JDBC drivers, Guava internals) throw these for internal bugs unrelated to user input. A global `IllegalArgumentException → 400` mapping will return misleading client errors for server-side bugs, causing clients to retry in loops.

Instead, define a **sealed domain exception hierarchy** that maps cleanly to HTTP status codes:

```java
// Base domain exception — all business-rule violations extend this
public sealed class DomainException extends RuntimeException
    permits ValidationException, StateConflictException, NotFoundException {
    
    protected DomainException(String message) { super(message); }
}

// Bad input from the caller → 400
public sealed class ValidationException extends DomainException
    permits InvalidFieldException, MissingFieldException {
    
    public ValidationException(String message) { super(message); }
}

// Operation conflicts with current state → 409
public sealed class StateConflictException extends DomainException
    permits InsufficientFundsException, InvalidStateTransitionException {
    
    public StateConflictException(String message) { super(message); }
}

// Resource not found → 404
public final class NotFoundException extends DomainException {
    public NotFoundException(String message) { super(message); }
}
```

**Guava Preconditions still work** — wrap them at the service boundary:

```java
// In command handlers / services: catch Preconditions failures and rethrow as domain exceptions
try {
    Account updated = account.withdraw(command.amount());
} catch (IllegalArgumentException e) {
    throw new ValidationException(e.getMessage());
} catch (IllegalStateException e) {
    throw new StateConflictException(e.getMessage());
}
```

Alternatively, use domain exception factory methods directly in business logic instead of Preconditions where the exception type matters for HTTP mapping.

#### Global Exception Handler

- Map **domain exceptions** to specific HTTP status codes
- Let `IllegalArgumentException`/`IllegalStateException` fall through to **500** — they signal programming errors, not user errors
- Set `type` URI to identify the error category (stable, documented)
- Set `instance` URI to identify the specific request
- Add domain-specific properties via `setProperty()` when needed
- Log exceptions with contextual information

```java
@ControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ValidationException.class)
    public ProblemDetail handleValidation(ValidationException ex, HttpServletRequest request) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, ex.getMessage());
        problem.setTitle("Validation Error");
        problem.setType(URI.create("https://api.example.com/errors/validation"));
        problem.setInstance(URI.create(request.getRequestURI()));
        return problem;
    }

    @ExceptionHandler(StateConflictException.class)
    public ProblemDetail handleStateConflict(StateConflictException ex, HttpServletRequest request) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, ex.getMessage());
        problem.setTitle("State Conflict");
        problem.setType(URI.create("https://api.example.com/errors/state-conflict"));
        problem.setInstance(URI.create(request.getRequestURI()));
        return problem;
    }

    @ExceptionHandler(NotFoundException.class)
    public ProblemDetail handleNotFound(NotFoundException ex, HttpServletRequest request) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        problem.setTitle("Not Found");
        problem.setType(URI.create("https://api.example.com/errors/not-found"));
        problem.setInstance(URI.create(request.getRequestURI()));
        return problem;
    }

    @ExceptionHandler(InsufficientFundsException.class)
    public ProblemDetail handleInsufficientFunds(InsufficientFundsException ex, HttpServletRequest request) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, ex.getMessage());
        problem.setTitle("Insufficient Funds");
        problem.setType(URI.create("https://api.example.com/errors/insufficient-funds"));
        problem.setInstance(URI.create(request.getRequestURI()));
        problem.setProperty("accountId", ex.getAccountId().value());
        return problem;
    }

    // Unhandled exceptions (including bare IllegalArgumentException from libraries) → 500
    @ExceptionHandler(Exception.class)
    public ProblemDetail handleUnexpected(Exception ex, HttpServletRequest request) {
        log.error("Unhandled exception on {}", request.getRequestURI(), ex);
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
            HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred");
        problem.setTitle("Internal Error");
        problem.setType(URI.create("https://api.example.com/errors/internal"));
        problem.setInstance(URI.create(request.getRequestURI()));
        return problem;
    }
}
```

### Frontend Error Handling

Frontend applications built with React + Vite (or similar bundlers with code splitting) require three layers of error handling set up from day one.

#### 1. Global chunk load recovery (`main.tsx` / entry point)

After every deployment, browser-cached HTML references old content-hashed chunk filenames that no longer exist on the server. The resulting `Failed to fetch dynamically imported module` error is an unhandled promise rejection — it occurs before React renders and is **not** caught by an `ErrorBoundary`. Add this handler in the entry point:

```ts
// main.tsx — must be registered before createRoot()
window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason?.message ?? '';
  if (
    msg.includes('Failed to fetch dynamically imported module') ||
    event.reason?.name === 'ChunkLoadError'
  ) {
    window.location.reload();
  }
});
```

This reloads the page, which fetches the new HTML with the correct chunk URLs. It is transparent to the user (sub-second) and requires no backend change.

#### 2. `ErrorBoundary` component

Every React app must have a top-level class component `ErrorBoundary` that:
- Catches synchronous render errors via `getDerivedStateFromError`
- Detects chunk load errors by name/message and shows a "Reload Page" action instead of a generic "Try Again"
- Wraps the entire app in `App.tsx`

```tsx
export class ErrorBoundary extends Component<Props, State> {
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      const isChunkError =
        this.state.error?.name === 'ChunkLoadError' ||
        this.state.error?.message?.includes('Failed to fetch dynamically imported module');

      return (
        <ErrorFallback
          title={isChunkError ? 'App updated — please reload' : 'Something went wrong'}
          description={
            isChunkError
              ? 'A new version was deployed. Reload to continue.'
              : this.state.error?.message ?? 'An unexpected error occurred.'
          }
          action={isChunkError ? () => window.location.reload() : this.handleReset}
          actionLabel={isChunkError ? 'Reload Page' : 'Try Again'}
        />
      );
    }
    return this.props.children;
  }
}
```

#### 3. User-facing error messages come from the API

**Never hardcode domain error text on the frontend.** The backend `ApiException` message is the single source of truth.

```tsx
// ❌ FORBIDDEN — hardcoded domain message
<ErrorState message="Booking not found or invalid token." />

// ✅ REQUIRED — read from API response
const errorMessage = (error as ApiError)?.message ?? 'Something went wrong. Please try again.';
<ErrorState message={errorMessage} />
```

The `??` fallback must be generic — it exists only for network-level failures, never to describe a business outcome.

#### Checklist for every new frontend project

- [ ] `unhandledrejection` handler registered in the entry point before `createRoot()`
- [ ] Top-level `ErrorBoundary` in `App.tsx`
- [ ] `ErrorBoundary` distinguishes chunk load errors from generic errors
- [ ] All domain error messages read from `error.message` in the API response
- [ ] Generic fallback strings are non-descriptive ("Something went wrong")

### Logging & Monitoring

- Implement structured logging using SLF4J and Logback
- Include correlation IDs for distributed tracing
- Log Preconditions failures with appropriate context
- Define appropriate log levels for different scenarios
- Monitor application health with Spring Actuator
- Implement custom health checks for external dependencies
- Set up metrics collection for key business operations

### Security

- Implement proper authentication and authorization
- Use Preconditions to validate security contexts and permissions
- Encrypt sensitive data at rest and in transit
- Implement input validation at all trust boundaries using Preconditions
- Follow the principle of least privilege
- Audit all security-relevant events
- Regularly review and update dependencies
- Implement proper secrets management

### Performance

- Use connection pooling for database connections
- Implement caching for frequently accessed, rarely changing data
- Use asynchronous processing for non-critical operations
- Optimize database queries and indexes
- Implement pagination for large result sets
- Consider read-replicas for read-heavy workloads
- Be mindful that Preconditions checks have minimal performance overhead

### Virtual Thread Pitfalls (Critical for Java 23+)

Virtual threads enable synchronous-style code with high concurrency, but they break assumptions that held for platform threads. These issues cause **production deadlocks and performance cliffs** that do not appear in unit or integration tests.

#### 1. Pinned carriers from `synchronized` blocks
When a virtual thread enters a `synchronized` block and then performs a blocking operation (I/O, `Thread.sleep`, `Lock.lock`), it **pins** the carrier thread — the virtual thread cannot unmount, and the carrier is blocked. With the default carrier pool size (number of CPUs), a handful of pinned threads can exhaust the pool and deadlock the application.

**Fix:** Replace `synchronized` with `ReentrantLock` in any code path that may block while holding a lock.

```java
// ❌ Pins the carrier if any blocking call happens inside
synchronized (lock) {
    result = externalService.call(); // blocks → carrier pinned
}

// ✅ Virtual thread can unmount while waiting for the lock
private final ReentrantLock lock = new ReentrantLock();
lock.lock();
try {
    result = externalService.call();
} finally {
    lock.unlock();
}
```

Audit third-party libraries too — JDBC drivers, HTTP clients, and caching libraries may use `synchronized` internally. Check for JEP 491 (JDK 24+) which removes pinning for `synchronized`.

#### 2. Thread-local abuse
Virtual threads are cheap and numerous — millions can exist simultaneously. `ThreadLocal` storage that was sized for a pool of 200 platform threads now multiplies by orders of magnitude. Memory-heavy thread-locals (request contexts, transaction state, MDC logging) can cause OOM.

**Fix:** Use scoped values (`ScopedValue`, preview in Java 23+) for request-scoped data. For libraries that rely on `ThreadLocal` (SLF4J MDC, Spring's `TransactionSynchronizationManager`), verify they have virtual-thread-compatible versions or bounded cleanup.

#### 3. Connection pool sizing
HikariCP defaults (max pool size = 10) assume platform threads where the pool size roughly matches the thread count. With virtual threads, thousands of concurrent requests can each attempt to acquire a connection, exhausting the pool instantly. The symptoms are request timeouts with a healthy-looking database.

**Fix:** Set `maximumPoolSize` to match your **database connection limit** divided by application instances, not your thread count. Monitor `HikariPool-1.pool.PendingConnections` — if it spikes, the pool is too small for the virtual-thread concurrency level.

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 50   # match to DB max_connections / instance count
      connection-timeout: 5000 # fail fast rather than queue indefinitely
```

### Testing

#### Two-Tier Testing Strategy
1. **Pure logic unit tests:** Core evaluation/processing logic is infrastructure-free, so test it exhaustively — every edge case, boundary, and permutation. These run in seconds with no containers or mocks. This is where you achieve depth of coverage.
2. **Integration tests (Testcontainers):** Verify the orchestration — service fetches data, calls pure logic, publishes/persists results. Real database, real broker, real cache. These prove the plumbing works.

#### General Testing Guidelines
- Write unit tests for domain logic including Preconditions validation
- Test both valid and invalid scenarios to ensure Preconditions work correctly
- Write integration tests for repositories and external service clients
- Implement end-to-end tests for critical flows
- Use test containers for integration testing
- Mock external dependencies in unit tests
- Measure and maintain test coverage
- Test exception scenarios thrown by Preconditions

```java
// Example test for Preconditions validation
@Test
void shouldThrowExceptionWhenWithdrawingNegativeAmount() {
    Account account = createTestAccount();
    Money negativeAmount = Money.of(new BigDecimal("-100.00"), USD);
    
    IllegalArgumentException exception = assertThrows(
        IllegalArgumentException.class,
        () -> account.withdraw(negativeAmount)
    );
    
    assertThat(exception.getMessage())
        .contains("Withdrawal amount must be positive");
}

@Test
void shouldThrowExceptionWhenCreatingAccountWithNullName() {
    IllegalArgumentException exception = assertThrows(
        IllegalArgumentException.class,
        () -> ImmutableAccount.builder()
            .id(AccountId.generate())
            .accountHolderName(null) // This will trigger Preconditions
            .accountType(AccountType.CHECKING)
            .balance(Balance.zero(USD))
            .status(AccountStatus.ACTIVE)
            .build()
    );
    
    assertThat(exception.getMessage())
        .contains("Account holder name cannot be null");
}
```

## DevOps Considerations

### Database Migrations (Flyway)

Every schema change goes through Flyway. No manual DDL in production.

#### Migration Rules
- **One migration per change.** Each migration file does one logical thing (add a column, create a table, add an index). Do not bundle unrelated changes.
- **Naming convention:** `V{version}__{description}.sql` (e.g., `V025__add_status_column_to_accounts.sql`)
- **Forward-only.** Never edit a migration that has been applied to any shared environment (dev, staging, prod). Write a new migration to fix mistakes.
- **Backward-compatible during rolling deployments.** During a rolling deploy, old application instances and new instances run simultaneously against the same database. Every migration must be compatible with both the old and new code versions.

#### Backward-Compatible Migration Patterns

| Operation | Safe Pattern | Unsafe Pattern |
|-----------|-------------|----------------|
| Add column | `ALTER TABLE ADD COLUMN ... DEFAULT ...` (nullable or with default) | Adding a `NOT NULL` column without a default |
| Remove column | Deploy code that ignores the column first, then drop in a later release | Dropping a column while old code still reads it |
| Rename column | Add new column → backfill → deploy code using new column → drop old column (3-phase) | `ALTER TABLE RENAME COLUMN` in a single deploy |
| Add constraint | Add as `NOT VALID`, then `VALIDATE CONSTRAINT` in a separate migration (avoids full table lock) | `ADD CONSTRAINT` on a large table in one step |

#### Migration Testing
- Integration tests run Flyway automatically against Testcontainers — this validates migration syntax and ordering.
- For data migrations (backfills), write a test that seeds data in the old shape, runs the migration, and asserts the new shape.

### Deployment & Operational Readiness

#### Health Checks & Probes

| Probe | Purpose | What to check | Failure behavior |
|-------|---------|----------------|-----------------|
| **Liveness** (`/actuator/health/liveness`) | "Is the process stuck?" | Deadlock detection, OOM state | Kubernetes restarts the pod |
| **Readiness** (`/actuator/health/readiness`) | "Can this instance serve traffic?" | Database connection, message broker connection, Flyway migration status | Kubernetes removes from load balancer but does not restart |
| **Startup** (`/actuator/health/startup`) | "Has the app finished initializing?" | All beans loaded, caches warmed | Kubernetes waits before checking liveness |

Configure Spring Boot Actuator to expose separate probe endpoints:
```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true
      group:
        readiness:
          include: db, rabbit, flyway
        liveness:
          include: livenessState
```

#### Graceful Shutdown
When a pod receives SIGTERM, in-flight requests and transactions must complete before the process exits.

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

Set the Kubernetes `terminationGracePeriodSeconds` to at least `timeout-per-shutdown-phase + 10s` to allow Spring to drain before the forced kill.

#### Circuit Breakers for External Dependencies
Every external API client must have a circuit breaker (Resilience4j). Without one, a downstream outage cascades into your service via thread/connection exhaustion.

```java
@CircuitBreaker(name = "paymentGateway", fallbackMethod = "handlePaymentGatewayDown")
public PaymentResult processPayment(PaymentRequest request) {
    return paymentGatewayClient.charge(request);
}
```

Configure thresholds per dependency:
- `failureRateThreshold`: 50% (open circuit after half of calls fail)
- `waitDurationInOpenState`: 30s (how long before a retry)
- `slidingWindowSize`: 20 (number of calls to evaluate)

#### Message Broker Resilience (RabbitMQ)
- **Connection recovery:** Enable automatic reconnection (`spring.rabbitmq.connection-timeout`, `requested-heartbeat`). Test by killing the RabbitMQ container during integration tests.
- **Dead-letter queues:** Every queue must have a DLQ configured. Messages that fail after `x-delivery-limit` retries go to the DLQ.
- **Message ordering:** RabbitMQ guarantees ordering per queue per consumer. If ordering matters across consumers, use a single consumer with concurrency=1 for that queue, or partition by key.
- **Publisher confirms:** Enable publisher confirms (`spring.rabbitmq.publisher-confirm-type=correlated`) for messages where delivery must be guaranteed.

#### CI/CD Pipeline
- Implement CI/CD pipelines with automated testing gates
- Use infrastructure as code
- Implement proper monitoring and alerting
- Define SLOs (Service Level Objectives)
- Implement canary deployments — route a small percentage of traffic to the new version, monitor error rate and latency dashboards, auto-rollback if SLO breached
- Set up structured logging infrastructure
- Monitor domain exception rates as they indicate data quality or integration issues

## Appendix

### Preconditions Best Practices Summary

1. **Always provide meaningful error messages** with context and relevant values
2. **Use appropriate Preconditions methods**:
   - `checkArgument()` for parameter validation
   - `checkState()` for business rules and object state
   - `checkArgument(x != null, ...)` for null checks (consistent IllegalArgumentException)
3. **Prefer `checkArgument(x != null, ...)` over `checkNotNull()`** for consistent exception types. At service boundaries, catch and rethrow as domain exceptions (see Error Handling)
4. **Place checks early** in methods and constructors
5. **Use `@Value.Check`** in Immutables for comprehensive object validation
5. **Include relevant values** in error messages using format strings
6. **Be specific** about what went wrong and what was expected
7. **Group related validations** logically
8. **Test both positive and negative scenarios** to ensure validations work correctly

### Migration from @Value.Check to Preconditions

When migrating existing validation logic:

```java
// Before: Using @Value.Check with manual validation
@Value.Check
protected void check() {
    if (amount.compareTo(BigDecimal.ZERO) < 0) {
        throw new IllegalArgumentException("Amount cannot be negative");
    }
}

// After: Using Preconditions
@Value.Check
protected void check() {
    checkArgument(amount().compareTo(BigDecimal.ZERO) >= 0, 
        "Amount cannot be negative: %s", amount());
}
```

### Command Dispatcher and Strong Consistency

Our architecture requires a dedicated Command Dispatcher that:
1. Routes commands to the appropriate handler
2. Maintains strong transactional consistency (handlers run synchronously within `@Transactional`)
3. Handles failures and retries when appropriate
4. Validates commands using Preconditions before dispatching

```java
public interface CommandHandler<C, R> {
    R handle(C command);
}

@Service
public class CommandDispatcher {
    private final Map<Class<?>, CommandHandler<?, ?>> handlers;

    @Autowired
    public CommandDispatcher(List<CommandHandler<?, ?>> handlerList) {
        checkArgument(handlerList != null && !handlerList.isEmpty(),
            "At least one command handler must be provided");

        this.handlers = handlerList.stream()
            .collect(Collectors.toMap(
                handler -> getCommandType(handler.getClass()),
                Function.identity()
            ));
    }

    @SuppressWarnings("unchecked")
    public <C, R> R dispatch(C command) {
        checkArgument(command != null, "Command cannot be null");

        CommandHandler<C, R> handler = (CommandHandler<C, R>) handlers.get(command.getClass());
        checkState(handler != null, "No handler found for command type: %s", command.getClass());

        return handler.handle(command);
    }

    private Class<?> getCommandType(Class<?> handlerClass) {
        // Extract command type from handler via reflection
        checkArgument(handlerClass != null, "Handler class cannot be null");
        // ... implementation details
    }
}
```