import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  Clock3,
  Download,
  ExternalLink,
  FileArchive,
  Filter,
  Library,
  LockKeyhole,
  PlayCircle,
  Search,
  ShoppingCart,
  Star,
  UserRound,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import {
  getDeliveryLabel,
  getDeliveryModes,
  getLiveStatus,
  getRefundInfo,
  WATCH_REFUND_LIMIT,
} from "../utils/courseState";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  Progress,
  Segmented,
} from "../components/ui";

const refundInfo = getRefundInfo;

const CourseCard = ({ course }) => {
  const info = refundInfo(course);
  const liveStatus = getLiveStatus(course);
  const modes = getDeliveryModes(course);
  const deliveryLabel = getDeliveryLabel(course);
  const isLive = modes.includes("live");
  return (
    <article className="market-card">
      <Link
        to={`/courses/${course.id}`}
        className={`course-cover ${course.category.toLowerCase()}`}
      >
        <span>{course.category.slice(0, 2).toUpperCase()}</span>
        <Badge tone={isLive ? "danger" : "info"}>
          {deliveryLabel}
        </Badge>
      </Link>
      <div className="market-card-body">
        <div className="badge-row">
          <Badge>{course.category}</Badge>
          {course.purchased && (
            <Badge tone="success">
              <Check size={12} /> Purchased
            </Badge>
          )}
          {liveStatus && (
            <Badge tone={liveStatus === "Live now" ? "success" : "neutral"}>
              {liveStatus}
            </Badge>
          )}
        </div>
        <Link to={`/courses/${course.id}`}>
          <h3>{course.title}</h3>
        </Link>
        <p className="byline">
          {course.trainer} · <Star size={14} fill="currentColor" />{" "}
          {course.rating}
        </p>
        <div className="meta-grid">
          <span>
            <Clock3 size={16} /> {course.duration} min
          </span>
          <span>
            <BookOpen size={16} />{" "}
            {course.capacity
              ? `${course.enrolled}/${course.capacity} enrolled`
              : course.structure}
          </span>
          <span>
            <ExternalLink size={16} /> {deliveryLabel}
          </span>
          <span>
            <CalendarDays size={16} />{" "}
            {course.startsAt
              ? new Date(course.startsAt).toLocaleDateString("en-SG", {
                  dateStyle: "medium",
                })
              : "Self-paced"}
          </span>
        </div>
        {course.purchased && !isLive && !modes.includes("local") && (
          <Progress
            value={Math.round((course.watched / course.duration) * 100)}
            label="Viewing progress"
          />
        )}
        <div className="market-card-footer">
          <div>
            {course.purchased ? (
              <>
                <small>Refund status</small>
                <b className={info.eligible ? "text-success" : "text-danger"}>
                  {info.summary}
                </b>
              </>
            ) : (
              <>
                <small>Course price</small>
                <b>{course.price} points</b>
              </>
            )}
          </div>
          <Link className="button secondary sm" to={`/courses/${course.id}`}>
            {course.purchased ? "Open course" : "View course"}
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </article>
  );
};

export function CourseMarketplacePage() {
  const { courses } = usePlatform();
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("All");
  const [ownership, setOwnership] = useState("All");
  const filtered = useMemo(
    () =>
      courses.filter(
        (course) =>
          course.isPublished !== false &&
          (format === "All" ||
            getDeliveryModes(course).includes(format.toLowerCase())) &&
          (ownership === "All" ||
            (ownership === "Purchased") === course.purchased) &&
          `${course.title} ${course.trainer} ${course.category}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [courses, query, format, ownership],
  );
  return (
    <>
      <Card className="market-toolbar">
        <div className="search-field">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by course, trainer or category"
          />
        </div>
        <div className="toolbar-filters">
          <Filter size={17} />
          <Segmented
            options={["All", "Cloud", "Local", "Live", "Record"]}
            value={format}
            onChange={setFormat}
          />
          <Segmented
            options={[
              "All",
              "Purchased",
              { label: "Available", value: "Available" },
            ]}
            value={ownership}
            onChange={setOwnership}
          />
        </div>
      </Card>
      <div className="result-bar">
        <span>
          <b>{filtered.length}</b> courses
        </span>
        <small>
          Course cards show delivery, access and refund basis before purchase.
        </small>
      </div>
      {filtered.length ? (
        <div className="market-grid">
          {filtered.map((course) => (
            <CourseCard key={course.id} course={course} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Search}
          title="No matching courses"
          description="Try a different search term or clear one of the filters."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery("");
                setFormat("All");
                setOwnership("All");
              }}
            >
              Clear filters
            </Button>
          }
        />
      )}
    </>
  );
}

export function CourseDetailPage() {
  const { id } = useParams();
  const {
    courses,
    cart,
    addToCart,
    downloadCourse,
    updateCourseProgress,
    notify,
  } = usePlatform();
  const navigate = useNavigate();
  const [downloadModal, setDownloadModal] = useState(false);
  const [playerModal, setPlayerModal] = useState(false);
  const [watchedMinutes, setWatchedMinutes] = useState(0);
  const course = courses.find((item) => item.id === id);
  if (!course)
    return (
      <EmptyState
        icon={BookOpen}
        title="Course not found"
        description="This course is not available in the current prototype."
      />
    );
  const info = refundInfo(course);
  const liveStatus = getLiveStatus(course);
  const modes = getDeliveryModes(course);
  const deliveryLabel = getDeliveryLabel(course);
  const isLive = modes.includes("live");
  const isLocal = modes.includes("local");
  const inCart = cart.includes(course.id);
  return (
    <>
      <button className="back-link" onClick={() => navigate(-1)}>
        <ArrowLeft size={16} /> Back to marketplace
      </button>
      <Card className="detail-hero">
        <div className={`detail-mark ${course.category.toLowerCase()}`}>
          {course.category.slice(0, 2).toUpperCase()}
        </div>
        <div className="detail-copy">
          <div className="badge-row">
            <Badge tone={isLive ? "danger" : "info"}>
              {deliveryLabel}
            </Badge>
            <Badge>{course.structure}</Badge>
            {course.purchased && (
              <Badge tone="success">
                <Check size={13} /> Purchased
              </Badge>
            )}
            {liveStatus && (
              <Badge
                tone={liveStatus === "Live now" ? "success" : "neutral"}
              >
                {liveStatus}
              </Badge>
            )}
          </div>
          <h2>{course.title}</h2>
          <p>{course.description}</p>
          <div className="profile-meta">
            <span>
              <UserRound size={15} />{" "}
              <Link to="/public-profile/trainer-a">{course.trainer}</Link>
            </span>
            <span>
              <Star size={15} fill="currentColor" /> {course.rating}
            </span>
            <span>
              <Clock3 size={15} /> {course.duration} minutes
            </span>
          </div>
        </div>
        <aside className="purchase-box">
          {course.purchased ? (
            <>
              <span className="eyebrow">Your access</span>
              <strong>
                {isLive ? liveStatus : "Available"}
              </strong>
              <p>
                {isLive
                  ? liveStatus === "Ended"
                    ? course.replay
                      ? "The session ended. A replay may be available."
                      : "The session ended and no replay is available."
                    : `Starts ${new Date(course.startsAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}`
                  : isLocal
                    ? "Download access is protected and recorded by the server"
                    : "Start or continue anytime"}
              </p>
              <Button
                className="wide"
                disabled={
                  isLive &&
                  liveStatus === "Ended" &&
                  !course.replay
                }
                onClick={() => {
                  if (isLive)
                    notify(
                      liveStatus === "Ended"
                        ? "Replay instructions opened."
                        : "External class instructions opened.",
                    );
                  else if (isLocal) {
                    setDownloadModal(true);
                  } else {
                    setWatchedMinutes(course.watched || 0);
                    setPlayerModal(true);
                  }
                }}
              >
                {isLive ? (
                  <ExternalLink size={17} />
                ) : isLocal ? (
                  <Download size={17} />
                ) : (
                  <PlayCircle size={17} />
                )}{" "}
                {isLive
                  ? liveStatus === "Ended"
                    ? course.replay
                      ? "View replay"
                      : "Course ended"
                    : "View schedule"
                  : isLocal
                    ? "Download Local package"
                    : "Open course"}
              </Button>
            </>
          ) : (
            <>
              <span className="eyebrow">Course price</span>
              <strong>
                {course.price} <small>points</small>
              </strong>
              <div className="purchase-policy-summary">
                <b>{deliveryLabel}</b>
                <span>{info.detail}</span>
              </div>
              <Button
                className="wide"
                disabled={course.purchaseEnabled === false || inCart}
                onClick={() => addToCart(course.id)}
              >
                <ShoppingCart size={17} /> {inCart ? "Already in cart" : "Add to cart"}
              </Button>
              {course.purchaseEnabled === false && (
                <small>Enrolment is unavailable for this delivery configuration.</small>
              )}
            </>
          )}
        </aside>
      </Card>
      <div className="content-grid detail-columns">
        <div className="stack">
          <Card>
            <div className="card-heading">
              <div>
                <span className="eyebrow">Learning structure</span>
                <h3>
                  {isLive
                    ? "Course schedule"
                    : "Course modules"}
                </h3>
              </div>
              <Badge
                tone={isLive ? "danger" : "info"}
              >
                {deliveryLabel}
              </Badge>
            </div>
            <div className="timeline-list">
              {course.modules.map((module, index) => (
                <div key={module}>
                  <span>{index + 1}</span>
                  <div>
                    <b>{module}</b>
                    <small>
                      {isLive
                        ? `${course.delivery} · scheduled externally`
                        : isLocal
                          ? "Local downloadable module"
                          : "Hosted self-paced module"}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card
            className={
              info.eligible ? "policy-card eligible" : "policy-card ineligible"
            }
          >
            <div className="card-heading">
              <div>
                <span className="eyebrow">Refund policy</span>
                <h3>
                  {info.eligible
                    ? "Refund currently available"
                    : course.purchased
                      ? "Course is not refundable"
                      : "Review before purchase"}
                </h3>
              </div>
              <Badge
                tone={
                  info.eligible
                    ? "success"
                    : course.purchased
                      ? "danger"
                      : "neutral"
                }
              >
                {course.purchased
                  ? info.eligible
                    ? "Eligible"
                    : "Not eligible"
                  : "Policy preview"}
              </Badge>
            </div>
            <p>{info.detail}</p>
            {!isLive && !isLocal && (
              <div className="policy-facts">
                <span>
                  <b>{info.progress ?? 0}%</b> watched
                </span>
                <span>
                  <b>{course.purchasedAt ? "Recorded" : "At checkout"}</b>{" "}
                  purchase time
                </span>
                <span>
                  <b>{WATCH_REFUND_LIMIT * 100}%</b> maximum
                </span>
              </div>
            )}
          </Card>
        </div>
        <div className="stack">
          <Card>
            <span className="eyebrow">Course information</span>
            <dl className="detail-list">
              <div>
                <dt>Category</dt>
                <dd>{course.category}</dd>
              </div>
              <div>
                <dt>Delivery</dt>
                <dd>{deliveryLabel}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>
                  {isLive
                    ? `External provider · ${course.delivery}`
                    : isLocal
                      ? "Protected download"
                      : "Hosted on CoLearnX"}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{course.duration} minutes</dd>
              </div>
              <div>
                <dt>Structure</dt>
                <dd>{course.structure}</dd>
              </div>
              <div>
                <dt>Replay</dt>
                <dd>
                  {modes.includes("record")
                    ? "Included with the associated Live course"
                    : "Not included"}
                </dd>
              </div>
              <div>
                <dt>Capacity</dt>
                <dd>
                  {course.capacity
                    ? `${course.enrolled} enrolled · ${Math.max(0, course.capacity - course.enrolled)} seats remaining`
                    : "No fixed capacity"}
                </dd>
              </div>
              <div>
                <dt>Prerequisites</dt>
                <dd>{course.prerequisites || "None stated"}</dd>
              </div>
              <div>
                <dt>Tags</dt>
                <dd>{course.tags?.join(", ") || "None"}</dd>
              </div>
            </dl>
          </Card>
          {course.purchased && (
            <Card>
              <span className="eyebrow">Course actions</span>
              <div className="stack compact">
                {isLocal && (
                  <Button
                    variant="secondary"
                    disabled={
                      course.downloaded || course.refundStatus === "Pending"
                    }
                    onClick={() => setDownloadModal(true)}
                  >
                    <Download size={17} />{" "}
                    {course.downloaded
                      ? "Video downloaded"
                      : course.refundStatus === "Pending"
                        ? "Download locked during refund review"
                      : "Download Local package"}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={!info.eligible || course.refundStatus === "Pending"}
                  onClick={() => navigate(`/refund/${course.id}`)}
                >
                  {course.refundStatus === "Pending"
                    ? "Refund pending"
                    : "Request refund"}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
      {downloadModal && (
        <Modal
          title="Download Local package?"
          onClose={() => setDownloadModal(false)}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setDownloadModal(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  downloadCourse(course.id);
                  setDownloadModal(false);
                }}
              >
                Confirm download
              </Button>
            </>
          }
        >
          <div className="warning-box">
            <Download size={22} />
            <div>
              <b>Local delivery is non-refundable in V1.</b>
              <p>
                The back end must confirm the completed download/access event
                and store it as service-delivery evidence.
              </p>
            </div>
          </div>
        </Modal>
      )}
      {playerModal && (
        <Modal
          title={`Learning progress · ${course.title}`}
          onClose={() => setPlayerModal(false)}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setPlayerModal(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  updateCourseProgress(course.id, watchedMinutes);
                  setPlayerModal(false);
                }}
              >
                Save progress
              </Button>
            </>
          }
        >
          <div className="player-simulator">
            <PlayCircle size={42} />
            <div>
              <b>Prototype course player</b>
              <p>
                Move the slider to simulate how much of the course has been
                watched. Refund eligibility updates when you save.
              </p>
            </div>
          </div>
          <label className="progress-control">
            <span>
              Watched <b>{watchedMinutes}</b> of {course.duration} minutes
            </span>
            <input
              type="range"
              min="0"
              max={course.duration}
              value={watchedMinutes}
              onChange={(event) => setWatchedMinutes(Number(event.target.value))}
            />
          </label>
          <Progress
            value={Math.round((watchedMinutes / course.duration) * 100)}
            label="Simulated viewing progress"
          />
        </Modal>
      )}
    </>
  );
}

const ContentCard = ({ item }) => (
  <article className="content-card">
    <div className={`content-type ${item.category.toLowerCase()}`}>
      <FileArchive size={26} />
      <span>{item.type}</span>
    </div>
    <div>
      <div className="badge-row">
        <Badge>{item.category}</Badge>
        {item.purchased && (
          <Badge tone="success">
            <Check size={12} /> Owned
          </Badge>
        )}
      </div>
      <Link to={`/contents/${item.id}`}>
        <h3>{item.title}</h3>
      </Link>
      <p>{item.description}</p>
      <div className="content-card-meta">
        <span>{item.creator}</span>
        <span>
          <Star size={14} fill="currentColor" /> {item.rating}
        </span>
      </div>
      <div className="market-card-footer">
        <b>{item.purchased ? "Unlocked" : `${item.price} points`}</b>
        <Link className="button secondary sm" to={`/contents/${item.id}`}>
          {item.purchased ? "Open" : "View"}
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  </article>
);

export function ContentMarketplacePage() {
  const { contents } = usePlatform();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("All");
  const filtered = contents.filter(
    (item) =>
      item.isPublished !== false &&
      (type === "All" || item.type === type) &&
      `${item.title} ${item.creator} ${item.category}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <Card className="market-toolbar">
        <div className="search-field">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search contents, creators or categories"
          />
        </div>
        <Segmented
          options={[
            "All",
            "PDF",
            "Video",
            "Image",
            "File",
            "Files",
            "Asset",
            "Link",
          ]}
          value={type}
          onChange={setType}
        />
      </Card>
      <div className="result-bar">
        <span>
          <b>{filtered.length}</b> creator contents
        </span>
        <small>
          Content purchases unlock direct viewing or download access.
        </small>
      </div>
      <div className="content-market-grid">
        {filtered.map((item) => (
          <ContentCard key={item.id} item={item} />
        ))}
      </div>
    </>
  );
}

export function ContentDetailPage() {
  const { id } = useParams();
  const { contents, balance, buyContent, notify } = usePlatform();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const item = contents.find((content) => content.id === id);
  if (!item)
    return (
      <EmptyState
        icon={Library}
        title="Content not found"
        description="This creator resource is not available."
      />
    );
  return (
    <>
      <button className="back-link" onClick={() => navigate(-1)}>
        <ArrowLeft size={16} /> Back to marketplace
      </button>
      <Card className="content-detail-hero">
        <div className={`content-detail-mark ${item.category.toLowerCase()}`}>
          <FileArchive size={36} />
          <span>{item.type}</span>
        </div>
        <div>
          <div className="badge-row">
            <Badge>{item.category}</Badge>
            {item.purchased && (
              <Badge tone="success">
                <Check size={12} /> Purchased
              </Badge>
            )}
          </div>
          <h2>{item.title}</h2>
          <p>{item.description}</p>
          <div className="profile-meta">
            <span>
              <UserRound size={15} />{" "}
              <Link to="/public-profile/trainer-a">{item.creator}</Link>
            </span>
            <span>
              <Star size={15} fill="currentColor" /> {item.rating}
            </span>
          </div>
        </div>
      </Card>
      <div className="content-grid detail-columns">
        <Card>
          <span className="eyebrow">What you receive</span>
          <h3>Access after purchase</h3>
          <div className="access-list">
            <div>
              <Check size={18} />
              <span>Permanent access from My Learning</span>
            </div>
            <div>
              <Check size={18} />
              <span>View or download permission for this {item.type}</span>
            </div>
            <div>
              <Check size={18} />
              <span>Purchase recorded in your points wallet</span>
            </div>
          </div>
          <div className="preview-panel">
            <LockKeyhole size={26} />
            <div>
              <b>
                {item.purchased ? "Content is unlocked" : "Preview available"}
              </b>
              <p>
                {item.purchased
                  ? "Open the full resource from your learning library."
                  : "A short preview would appear here before purchase."}
              </p>
            </div>
          </div>
        </Card>
        <Card className="purchase-summary">
          <span className="eyebrow">Purchase summary</span>
          <div className="summary-row">
            <span>Content price</span>
            <b>{item.price} points</b>
          </div>
          <div className="summary-row">
            <span>Current balance</span>
            <b>{balance} points</b>
          </div>
          <div className="summary-row total">
            <span>Balance after purchase</span>
            <b>{item.purchased ? balance : balance - item.price} points</b>
          </div>
          {item.purchased ? (
            <Button
              className="wide"
              onClick={() => notify("Content opened from your library.")}
            >
              <Download size={17} /> Open content
            </Button>
          ) : (
            <Button
              className="wide"
              disabled={balance < item.price}
              onClick={() => setConfirm(true)}
            >
              Confirm purchase
            </Button>
          )}
        </Card>
      </div>
      {confirm && (
        <Modal
          title={`Purchase ${item.title}?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  buyContent(item.id);
                  setConfirm(false);
                }}
              >
                Pay {item.price} points
              </Button>
            </>
          }
        >
          <p>
            This will deduct <b>{item.price} points</b> from your unified wallet
            and unlock the {item.type} immediately.
          </p>
        </Modal>
      )}
    </>
  );
}

export { refundInfo };
