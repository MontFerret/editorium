package org.ferretlang.jetbrains.protocol.ferretd.daemon.v1;

import static io.grpc.MethodDescriptor.generateFullMethodName;

/**
 */
@io.grpc.stub.annotations.GrpcGenerated
public final class DaemonServiceGrpc {

  private DaemonServiceGrpc() {}

  public static final java.lang.String SERVICE_NAME = "ferretd.daemon.v1.DaemonService";

  // Static method descriptors that strictly reflect the proto.
  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest,
      org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse> getGetInfoMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "GetInfo",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest,
      org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse> getGetInfoMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest, org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse> getGetInfoMethod;
    if ((getGetInfoMethod = DaemonServiceGrpc.getGetInfoMethod) == null) {
      synchronized (DaemonServiceGrpc.class) {
        if ((getGetInfoMethod = DaemonServiceGrpc.getGetInfoMethod) == null) {
          DaemonServiceGrpc.getGetInfoMethod = getGetInfoMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest, org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "GetInfo"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse.getDefaultInstance()))
              .setSchemaDescriptor(new DaemonServiceMethodDescriptorSupplier("GetInfo"))
              .build();
        }
      }
    }
    return getGetInfoMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest,
      org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse> getShutdownMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "Shutdown",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest,
      org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse> getShutdownMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest, org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse> getShutdownMethod;
    if ((getShutdownMethod = DaemonServiceGrpc.getShutdownMethod) == null) {
      synchronized (DaemonServiceGrpc.class) {
        if ((getShutdownMethod = DaemonServiceGrpc.getShutdownMethod) == null) {
          DaemonServiceGrpc.getShutdownMethod = getShutdownMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest, org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "Shutdown"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse.getDefaultInstance()))
              .setSchemaDescriptor(new DaemonServiceMethodDescriptorSupplier("Shutdown"))
              .build();
        }
      }
    }
    return getShutdownMethod;
  }

  /**
   * Creates a new async stub that supports all call types for the service
   */
  public static DaemonServiceStub newStub(io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<DaemonServiceStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<DaemonServiceStub>() {
        @java.lang.Override
        public DaemonServiceStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new DaemonServiceStub(channel, callOptions);
        }
      };
    return DaemonServiceStub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports all types of calls on the service
   */
  public static DaemonServiceBlockingV2Stub newBlockingV2Stub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<DaemonServiceBlockingV2Stub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<DaemonServiceBlockingV2Stub>() {
        @java.lang.Override
        public DaemonServiceBlockingV2Stub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new DaemonServiceBlockingV2Stub(channel, callOptions);
        }
      };
    return DaemonServiceBlockingV2Stub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports unary and streaming output calls on the service
   */
  public static DaemonServiceBlockingStub newBlockingStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<DaemonServiceBlockingStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<DaemonServiceBlockingStub>() {
        @java.lang.Override
        public DaemonServiceBlockingStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new DaemonServiceBlockingStub(channel, callOptions);
        }
      };
    return DaemonServiceBlockingStub.newStub(factory, channel);
  }

  /**
   * Creates a new ListenableFuture-style stub that supports unary calls on the service
   */
  public static DaemonServiceFutureStub newFutureStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<DaemonServiceFutureStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<DaemonServiceFutureStub>() {
        @java.lang.Override
        public DaemonServiceFutureStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new DaemonServiceFutureStub(channel, callOptions);
        }
      };
    return DaemonServiceFutureStub.newStub(factory, channel);
  }

  /**
   */
  public interface AsyncService {

    /**
     */
    default void getInfo(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getGetInfoMethod(), responseObserver);
    }

    /**
     */
    default void shutdown(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getShutdownMethod(), responseObserver);
    }
  }

  /**
   * Base class for the server implementation of the service DaemonService.
   */
  public static abstract class DaemonServiceImplBase
      implements io.grpc.BindableService, AsyncService {

    @java.lang.Override public final io.grpc.ServerServiceDefinition bindService() {
      return DaemonServiceGrpc.bindService(this);
    }
  }

  /**
   * A stub to allow clients to do asynchronous rpc calls to service DaemonService.
   */
  public static final class DaemonServiceStub
      extends io.grpc.stub.AbstractAsyncStub<DaemonServiceStub> {
    private DaemonServiceStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected DaemonServiceStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new DaemonServiceStub(channel, callOptions);
    }

    /**
     */
    public void getInfo(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getGetInfoMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void shutdown(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getShutdownMethod(), getCallOptions()), request, responseObserver);
    }
  }

  /**
   * A stub to allow clients to do synchronous rpc calls to service DaemonService.
   */
  public static final class DaemonServiceBlockingV2Stub
      extends io.grpc.stub.AbstractBlockingStub<DaemonServiceBlockingV2Stub> {
    private DaemonServiceBlockingV2Stub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected DaemonServiceBlockingV2Stub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new DaemonServiceBlockingV2Stub(channel, callOptions);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse getInfo(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getGetInfoMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse shutdown(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getShutdownMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do limited synchronous rpc calls to service DaemonService.
   */
  public static final class DaemonServiceBlockingStub
      extends io.grpc.stub.AbstractBlockingStub<DaemonServiceBlockingStub> {
    private DaemonServiceBlockingStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected DaemonServiceBlockingStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new DaemonServiceBlockingStub(channel, callOptions);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse getInfo(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getGetInfoMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse shutdown(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getShutdownMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do ListenableFuture-style rpc calls to service DaemonService.
   */
  public static final class DaemonServiceFutureStub
      extends io.grpc.stub.AbstractFutureStub<DaemonServiceFutureStub> {
    private DaemonServiceFutureStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected DaemonServiceFutureStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new DaemonServiceFutureStub(channel, callOptions);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse> getInfo(
        org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getGetInfoMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse> shutdown(
        org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getShutdownMethod(), getCallOptions()), request);
    }
  }

  private static final int METHODID_GET_INFO = 0;
  private static final int METHODID_SHUTDOWN = 1;

  private static final class MethodHandlers<Req, Resp> implements
      io.grpc.stub.ServerCalls.UnaryMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ServerStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ClientStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.BidiStreamingMethod<Req, Resp> {
    private final AsyncService serviceImpl;
    private final int methodId;

    MethodHandlers(AsyncService serviceImpl, int methodId) {
      this.serviceImpl = serviceImpl;
      this.methodId = methodId;
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public void invoke(Req request, io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        case METHODID_GET_INFO:
          serviceImpl.getInfo((org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse>) responseObserver);
          break;
        case METHODID_SHUTDOWN:
          serviceImpl.shutdown((org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse>) responseObserver);
          break;
        default:
          throw new AssertionError();
      }
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public io.grpc.stub.StreamObserver<Req> invoke(
        io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        default:
          throw new AssertionError();
      }
    }
  }

  public static final io.grpc.ServerServiceDefinition bindService(AsyncService service) {
    return io.grpc.ServerServiceDefinition.builder(getServiceDescriptor())
        .addMethod(
          getGetInfoMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest,
              org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse>(
                service, METHODID_GET_INFO)))
        .addMethod(
          getShutdownMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest,
              org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse>(
                service, METHODID_SHUTDOWN)))
        .build();
  }

  private static abstract class DaemonServiceBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoFileDescriptorSupplier, io.grpc.protobuf.ProtoServiceDescriptorSupplier {
    DaemonServiceBaseDescriptorSupplier() {}

    @java.lang.Override
    public com.google.protobuf.Descriptors.FileDescriptor getFileDescriptor() {
      return org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.DaemonProto.getDescriptor();
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.ServiceDescriptor getServiceDescriptor() {
      return getFileDescriptor().findServiceByName("DaemonService");
    }
  }

  private static final class DaemonServiceFileDescriptorSupplier
      extends DaemonServiceBaseDescriptorSupplier {
    DaemonServiceFileDescriptorSupplier() {}
  }

  private static final class DaemonServiceMethodDescriptorSupplier
      extends DaemonServiceBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoMethodDescriptorSupplier {
    private final java.lang.String methodName;

    DaemonServiceMethodDescriptorSupplier(java.lang.String methodName) {
      this.methodName = methodName;
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.MethodDescriptor getMethodDescriptor() {
      return getServiceDescriptor().findMethodByName(methodName);
    }
  }

  private static volatile io.grpc.ServiceDescriptor serviceDescriptor;

  public static io.grpc.ServiceDescriptor getServiceDescriptor() {
    io.grpc.ServiceDescriptor result = serviceDescriptor;
    if (result == null) {
      synchronized (DaemonServiceGrpc.class) {
        result = serviceDescriptor;
        if (result == null) {
          serviceDescriptor = result = io.grpc.ServiceDescriptor.newBuilder(SERVICE_NAME)
              .setSchemaDescriptor(new DaemonServiceFileDescriptorSupplier())
              .addMethod(getGetInfoMethod())
              .addMethod(getShutdownMethod())
              .build();
        }
      }
    }
    return result;
  }
}
