import { useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  Download,
  ExternalLink,
  FileArchive,
  GraduationCap,
  PlayCircle,
  RotateCcw,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import {
  getDeliveryLabel,
  getDeliveryModes,
  getLiveStatus,
  getRefundInfo,
} from "../utils/courseState";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FormField,
  Progress,
  Segmented,
  SuccessPanel,
} from "../components/ui";

export function CartPage() {
  const { cart, courses, balance, removeFromCart, checkout } = usePlatform();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(cart);
  const [acceptedPolicies, setAcceptedPolicies] = useState(false);
  const items = courses.filter(
    (course) => cart.includes(course.id) && !course.purchased,
  );
  const total = items
    .filter((course) => selected.includes(course.id))
    .reduce((sum, course) => sum + course.price, 0);
  const toggle = (id) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  const pay = () => {
    const order = checkout(selected);
    if (order) navigate(`/checkout-success/${order.id}`);
  };
  if (!items.length)
    return (
      <EmptyState
        icon={ShoppingCart}
        title="Your cart is empty"
        description="Browse the course marketplace and add courses you want to compare or purchase."
        action={
          <Link className="button primary" to="/courses">
            Browse courses
          </Link>
        }
      />
    );
  return (
    <div className="content-grid cart-layout">
      <Card className="cart-list">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Selected courses</span>
            <h3>{items.length} items in cart</h3>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={selected.length === items.length}
              onChange={() =>
                setSelected(
                  selected.length === items.length
                    ? []
                    : items.map((item) => item.id),
                )
              }
            />{" "}
            Select all
          </label>
        </div>
        {items.map((course) => (
          <div className="cart-row" key={course.id}>
            <input
              type="checkbox"
              checked={selected.includes(course.id)}
              onChange={() => toggle(course.id)}
              aria-label={`Select ${course.title}`}
            />
            <span className={`cart-thumb ${course.category.toLowerCase()}`}>
              {course.category.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <b>{course.title}</b>
              <small>
                {course.trainer} · {getDeliveryLabel(course)} ·{" "}
                {course.duration} min
              </small>
              <span className="cart-policy">
                {getRefundInfo({ ...course, purchased: false }).detail}
              </span>
            </div>
            <strong>{course.price} pts</strong>
            <button
              className="icon-button danger"
              onClick={() => {
                removeFromCart(course.id);
                setSelected((current) =>
                  current.filter((id) => id !== course.id),
                );
              }}
              aria-label={`Remove ${course.title}`}
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
      </Card>
      <Card className="order-summary">
        <span className="eyebrow">Checkout summary</span>
        <h3>Unified points payment</h3>
        <div className="summary-row">
          <span>Selected courses</span>
          <b>{selected.length}</b>
        </div>
        <div className="summary-row">
          <span>Total price</span>
          <b>{total} points</b>
        </div>
        <div className="summary-row">
          <span>Current balance</span>
          <b>{balance} points</b>
        </div>
        <div className="summary-row total">
          <span>Balance after payment</span>
          <b className={balance - total < 0 ? "text-danger" : ""}>
            {balance - total} points
          </b>
        </div>
        {balance < total && (
          <div className="warning-box compact">
            <AlertCircle size={19} />
            <span>You need {total - balance} more points.</span>
          </div>
        )}
        <label className="check-label policy-confirmation">
          <input
            type="checkbox"
            checked={acceptedPolicies}
            onChange={(event) => setAcceptedPolicies(event.target.checked)}
          />
          <span>
            I have reviewed each delivery label and refund policy above.
          </span>
        </label>
        <Button
          className="wide"
          disabled={!selected.length || balance < total || !acceptedPolicies}
          onClick={pay}
        >
          Checkout selected <ArrowRight size={17} />
        </Button>
        <Link className="button ghost wide" to="/courses">
          Continue browsing
        </Link>
      </Card>
    </div>
  );
}

export function CheckoutSuccessPage() {
  const { orderId } = useParams();
  const { orders, lastOrder } = usePlatform();
  const navigate = useNavigate();
  const order = orderId
    ? orders.find((item) => item.id === orderId)
    : lastOrder;
  if (!order)
    return (
      <EmptyState
        icon={ShoppingCart}
        title="No recent checkout"
        description="Complete a course purchase to view its order summary here."
        action={
          <Link className="button primary" to="/courses">
            Browse courses
          </Link>
        }
      />
    );
  return (
    <SuccessPanel
      title="Payment successful"
      description="Your courses are now available in My Learning and the transaction is recorded in your wallet."
    >
      <div className="order-receipt">
        <div>
          <span>Order ID</span>
          <b>{order.id}</b>
        </div>
        <div>
          <span>Paid with</span>
          <b>Unified points</b>
        </div>
        <div>
          <span>Total paid</span>
          <b>{order.total} points</b>
        </div>
        <div>
          <span>Remaining balance</span>
          <b>{order.remainingBalance} points</b>
        </div>
        <div>
          <span>Transaction reference</span>
          <b>{order.transactionReference}</b>
        </div>
        <section>
          <span>Purchased courses</span>
          {order.items.map((item) => (
            <p key={item.id}>
              <Check size={15} />
              <span>
                <b>{item.title}</b>
                <small>
                  {item.trainer} · {item.delivery} · Status: Unwatched
                </small>
                <small>{item.refundPolicy}</small>
              </span>
              <strong>{item.price} pts</strong>
            </p>
          ))}
        </section>
      </div>
      <Button onClick={() => navigate("/purchases")}>Go to My Learning</Button>
      <Button variant="secondary" onClick={() => navigate("/courses")}>
        Back to marketplace
      </Button>
      <Button variant="ghost" onClick={() => navigate("/orders")}>
        View order history
      </Button>
    </SuccessPanel>
  );
}

export function OrderHistoryPage() {
  const { orders } = usePlatform();
  if (!orders.length)
    return (
      <EmptyState
        icon={ShoppingCart}
        title="No course orders yet"
        description="Completed course checkouts will appear here with a permanent order reference."
        action={
          <Link className="button primary" to="/courses">
            Browse courses
          </Link>
        }
      />
    );
  return (
    <Card className="table-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Course purchases</span>
          <h3>Order history</h3>
        </div>
        <Badge tone="success">{orders.length} paid</Badge>
      </div>
      <div className="responsive-table">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Date</th>
              <th>Courses</th>
              <th>Total</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td><b>{order.id}</b></td>
                <td>{new Date(order.createdAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}</td>
                <td>{order.items.map((item) => item.title).join(", ")}</td>
                <td>{order.total} points</td>
                <td><Badge tone="success">{order.status}</Badge></td>
                <td>
                  <Link className="button secondary sm" to={`/checkout-success/${order.id}`}>
                    View details
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function PurchasesPage() {
  const { courses, contents, notify } = usePlatform();
  const [tab, setTab] = useState("Courses");
  const [status, setStatus] = useState("All");
  const purchasedCourses = courses.filter(
    (course) => course.purchased || course.learningStatus === "Refunded",
  );
  const visibleCourses = purchasedCourses.filter(
    (course) => status === "All" || course.learningStatus === status,
  );
  const purchasedContents = contents.filter((item) => item.purchased);
  return (
    <>
      <Card className="tabs-card">
        <Segmented
          options={["Courses", "Contents"]}
          value={tab}
          onChange={setTab}
        />
        <span>
          {tab === "Courses"
            ? purchasedCourses.length
            : purchasedContents.length}{" "}
          items
        </span>
      </Card>
      {tab === "Courses" && (
        <Card className="status-tabs">
          <span className="eyebrow">Learning status</span>
          <Segmented
            options={["All", "Unwatched", "Watching", "Watched", "Refunded"]}
            value={status}
            onChange={setStatus}
          />
        </Card>
      )}
      {tab === "Courses" ? (
        visibleCourses.length ? (
          <div className="learning-list">
            {visibleCourses.map((course) => {
              const info = getRefundInfo(course);
              const liveStatus = getLiveStatus(course);
              const modes = getDeliveryModes(course);
              const isLive = modes.includes("live");
              const isLocal = modes.includes("local");
              const progress = Math.round(
                (course.watched / course.duration) * 100,
              );
              const refunded = course.learningStatus === "Refunded";
              return (
                <Card className="learning-row" key={course.id}>
                  <span
                    className={`learning-icon ${course.category.toLowerCase()}`}
                  >
                    <GraduationCap size={22} />
                  </span>
                  <div className="learning-main">
                    <div className="badge-row">
                      <Badge
                        tone={
                          isLive ? "danger" : "info"
                        }
                      >
                        {getDeliveryLabel(course)}
                      </Badge>
                      <Badge tone={refunded ? "warning" : "success"}>
                        {course.learningStatus || "Unwatched"}
                      </Badge>
                      {course.refundStatus === "Pending" && (
                        <Badge tone="warning">Refund pending</Badge>
                      )}
                      {liveStatus && (
                        <Badge tone={liveStatus === "Live now" ? "success" : "neutral"}>
                          {liveStatus}
                        </Badge>
                      )}
                    </div>
                    <h3>{course.title}</h3>
                    <p>
                      {course.trainer} · {course.delivery}
                    </p>
                    {!refunded &&
                      (!isLive && !isLocal ? (
                        <Progress
                          value={progress}
                          label={`${course.watched} of ${course.duration} min`}
                        />
                      ) : (
                        <small>
                          {liveStatus === "Ended"
                            ? course.replay
                              ? "Session ended · replay may be available"
                              : "Session ended · no replay"
                            : `Starts ${new Date(course.startsAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}`}
                        </small>
                      ))}
                  </div>
                  <div className="learning-policy">
                    <small>Refund</small>
                    <b
                      className={
                        refunded
                          ? "text-success"
                          : info.eligible
                            ? "text-success"
                            : "text-danger"
                      }
                    >
                      {refunded
                        ? "Approved"
                        : info.eligible
                          ? "Eligible"
                          : "Not eligible"}
                    </b>
                    <span>
                      {refunded
                        ? `${course.price} points returned`
                        : info.summary}
                    </span>
                  </div>
                  {refunded ? (
                    <Badge tone="warning">Refunded</Badge>
                  ) : (
                    <Link
                      className="button secondary sm"
                      to={`/courses/${course.id}`}
                    >
                      {isLive ? (
                        <ExternalLink size={16} />
                      ) : isLocal ? (
                        <Download size={16} />
                      ) : (
                        <PlayCircle size={16} />
                      )}{" "}
                      Open
                    </Link>
                  )}
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={BookOpen}
            title={`No ${status.toLowerCase()} courses`}
            description="Courses will appear here when their learning or refund status changes."
          />
        )
      ) : (
        <div className="learning-list">
          {purchasedContents.map((item) => (
            <Card className="learning-row" key={item.id}>
              <span className={`learning-icon ${item.category.toLowerCase()}`}>
                <FileArchive size={22} />
              </span>
              <div className="learning-main">
                <div className="badge-row">
                  <Badge>{item.type}</Badge>
                  <Badge tone="success">Unlocked</Badge>
                </div>
                <h3>{item.title}</h3>
                <p>{item.creator} · Permanent access</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => notify(`${item.title} opened.`)}
              >
                <Download size={16} /> Open file
              </Button>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

export function RefundPage() {
  const { id } = useParams();
  const { courses, submitRefund } = usePlatform();
  const navigate = useNavigate();
  const [submitted, setSubmitted] = useState(false);
  const [reason, setReason] = useState("");
  const course = courses.find((item) => item.id === id);
  if (!course)
    return (
      <EmptyState
        icon={RotateCcw}
        title="Course not found"
        description="The selected course cannot be used for a refund request."
      />
    );
  const info = getRefundInfo(course);
  if (submitted)
    return (
      <SuccessPanel
        title="Refund request submitted"
        description="The request is pending administrator review. You can continue using the platform while the decision is processed."
      >
        <Button onClick={() => navigate("/purchases")}>
          Back to My Learning
        </Button>
      </SuccessPanel>
    );
  return (
    <div className="content-grid refund-layout">
      <div className="stack">
        <Card>
          <span className="eyebrow">Course and access</span>
          <h3>{course.title}</h3>
          <dl className="detail-list">
            <div>
              <dt>Delivery</dt>
              <dd>{getDeliveryLabel(course)}</dd>
            </div>
            <div>
              <dt>Paid</dt>
              <dd>{course.price} points</dd>
            </div>
            {!getDeliveryModes(course).includes("live") &&
            !getDeliveryModes(course).includes("local") ? (
              <>
                <div>
                  <dt>Viewing progress</dt>
                  <dd>
                    {Math.round((course.watched / course.duration) * 100)}%
                  </dd>
                </div>
                <div>
                  <dt>Downloaded</dt>
                  <dd>{course.downloaded ? "Yes" : "No"}</dd>
                </div>
              </>
            ) : getDeliveryModes(course).includes("local") ? (
              <div>
                <dt>Delivery evidence</dt>
                <dd>{course.downloaded ? "Completed" : "Not delivered"}</dd>
              </div>
            ) : (
              <div>
                <dt>Course start</dt>
                <dd>
                  {new Date(course.startsAt).toLocaleString("en-SG", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </dd>
              </div>
            )}
          </dl>
        </Card>
        <Card
          className={
            info.eligible ? "policy-card eligible" : "policy-card ineligible"
          }
        >
          <span className="eyebrow">Eligibility result</span>
          <h3>{info.eligible ? "Eligible for review" : "Not eligible"}</h3>
          <p>{info.detail}</p>
          <Badge tone={info.eligible ? "success" : "danger"}>
            {info.summary}
          </Badge>
        </Card>
      </div>
      <Card>
        <span className="eyebrow">Request form</span>
        <h3>Tell the reviewer what happened</h3>
        <p>
          Your reason will be shown with the policy evidence and purchase
          record.
        </p>
        <FormField label="Refund reason">
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={!info.eligible}
            placeholder="Explain why you want to request a refund"
          />
        </FormField>
        <div className="summary-row total">
          <span>Refund amount</span>
          <b>{course.price} points</b>
        </div>
        {!info.eligible && (
          <div className="warning-box compact">
            <AlertCircle size={19} />
            <span>
              This request cannot be submitted under the current policy.
            </span>
          </div>
        )}
        <div className="button-row">
          <Button
            disabled={
              !info.eligible ||
              reason.trim().length < 10 ||
              course.refundStatus === "Pending"
            }
            onClick={() => {
              const request = submitRefund({
                course,
                reason: reason.trim(),
              });
              if (request) setSubmitted(true);
            }}
          >
            Submit refund request
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
        {info.eligible &&
          reason.trim().length > 0 &&
          reason.trim().length < 10 && (
            <small className="field-note text-danger">
              Please enter at least 10 characters.
            </small>
          )}
      </Card>
    </div>
  );
}
